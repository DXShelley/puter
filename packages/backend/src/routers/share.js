const express = require('express');
const { Endpoint } = require('../util/expressutil');

const validator = require('validator');
const APIError = require('../api/APIError');
const { get_user, get_app } = require('../helpers');
const { Context } = require('../util/context');
const config = require('../config');
const FSNodeParam = require('../api/filesystem/FSNodeParam');
const { TYPE_DIRECTORY } = require('../filesystem/FSNodeContext');

const { PermissionUtil } = require('../services/auth/PermissionService');
const configurable_auth = require('../middleware/configurable_auth');
const { UsernameNotifSelector } = require('../services/NotificationService');
const { quot } = require('../util/strutil');
const { UtilFn } = require('../util/fnutil');
const { WorkList } = require('../util/workutil');

const router = express.Router();

const v0_2 = async (req, res) => {
    const svc_token = req.services.get('token');
    const svc_email = req.services.get('email');
    const svc_permission = req.services.get('permission');
    const svc_notification = req.services.get('notification');
    const svc_share = req.services.get('share');

    const lib_typeTagged = req.services.get('lib-type-tagged');

    const actor = Context.get('actor');
    
    // === Request Validators ===
    
    const validate_mode = UtilFn(mode => {
        if ( mode === 'strict' ) return true;
        if ( ! mode || mode === 'best-effort' ) return false;
        throw APIError.create('field_invalid', null, {
            key: 'mode',
            expected: '`strict`, `best-effort`, or undefined',
        });
    })
    
    // Expect: an array of usernames and/or emails
    const validate_recipients = UtilFn(recipients => {
        // A string can be adapted to an array of one string
        if ( typeof recipients === 'string' ) {
            recipients = [recipients];
        }
        // Must be an array
        if ( ! Array.isArray(recipients) ) {
            throw APIError.create('field_invalid', null, {
                key: 'recipients',
                expected: 'array or string',
                got: typeof recipients,
            })
        }
        return recipients;
    });
    
    const validate_shares = UtilFn(shares => {
        // Single-values get adapted into an array
        if ( ! Array.isArray(shares) ) {
            shares = [shares];
        }
        return shares;
    })
    
    // === Request Values ===

    const strict_mode =
        validate_mode.if(req.body.mode) ?? false;
    const req_recipients =
        validate_recipients.if(req.body.recipients) ?? [];
    const req_shares =
        validate_shares.if(req.body.shares) ?? [];
        
    // === State Values ===

    const recipients = [];
    const result = {
        // Metadata
        $: 'api:share',
        $version: 'v0.0.0',
        
        // Results
        status: null,
        recipients: Array(req_recipients.length).fill(null),
        shares: Array(req_shares.length).fill(null),
    }
    const recipients_work = new WorkList();
    const shares_work = new WorkList();
    
    // const assert_work_item = (wut, item) => {
    //     if ( item.$ !== wut ) {
    //         // This should never happen, so 500 is acceptable here
    //         throw new Error('work item assertion failed');
    //     }
    // }
    
    // === Request Preprocessing ===
    
    // --- Function that returns early in strict mode ---
    const serialize_result = () => {
        for ( let i=0 ; i < result.recipients.length ; i++ ) {
            if ( ! result.recipients[i] ) continue;
            if ( result.recipients[i] instanceof APIError ) {
                result.status = 'mixed';
                result.recipients[i] = result.recipients[i].serialize();
            }
        }
        for ( let i=0 ; i < result.shares.length ; i++ ) {
            if ( ! result.shares[i] ) continue;
            if ( result.shares[i] instanceof APIError ) {
                result.status = 'mixed';
                result.shares[i] = result.shares[i].serialize();
            }
        }
    };
    const strict_check = () =>{
        if ( ! strict_mode ) return;
        console.log('OK');
        if (
            result.recipients.some(v => v !== null) ||
            result.shares.some(v => v !== null)
        ) {
            console.log('DOESNT THIS??')
            serialize_result();
            result.status = 'aborted';
            res.status(218).send(result);
            console.log('HOWW???');
            return true;
        }
    }
    
    // --- Process Recipients ---
    
    // Expect: at least one recipient
    if ( req_recipients.length < 1 ) {
        throw APIError.create('field_invalid', null, {
            key: 'recipients',
            expected: 'at least one',
            got: 'none',
        })
    }
    
    for ( let i=0 ; i < req_recipients.length ; i++ ) {
        const value = req_recipients[i];
        recipients_work.push({ i, value })
    }
    recipients_work.lockin();
    
    // track: good candidate for sequence
    
    // Expect: each value should be a valid username or email
    for ( const item of recipients_work.list() ) {
        const { value, i } = item;
        
        if ( typeof value !== 'string' ) {
            item.invalid = true;
            result.recipients[i] =
                APIError.create('invalid_username_or_email', null, {
                    value,
                });
            continue;
        }

        if ( value.match(config.username_regex) ) {
            item.type = 'username';
            continue;
        }
        if ( validator.isEmail(value) ) {
            item.type = 'email';
            continue;
        }
        
        item.invalid = true;
        result.recipients[i] =
            APIError.create('invalid_username_or_email', null, {
                value,
            });
    }
    
    // Return: if there are invalid values in strict mode
    recipients_work.clear_invalid();
    
    // Expect: no emails specified yet
    //    AND  usernames exist
    for ( const item of recipients_work.list() ) {
        const allowed_types = ['email', 'username'];
        if ( ! allowed_types.includes(item.type) ) {
            item.invalid = true;
            result.recipients[item.i] =
                APIError.create('disallowed_value', null, {
                    key: `recipients[${item.i}].type`,
                    allowed: allowed_types,
                });
            continue;
        }
    }

    // Return: if there are invalid values in strict mode
    recipients_work.clear_invalid();

    for ( const item of recipients_work.list() ) {
        if ( item.type !== 'email' ) continue;
    
        const errors = [];
        if ( ! validator.isEmail(item.value) ) {
            errors.push('`email` is not valid');
        }
        
        if ( errors.length ) {
            item.invalid = true;
            result.recipients[item.i] =
                APIError.create('field_errors', null, {
                    key: `recipients[${item.i}]`,
                    errors,
                });
            continue;
        }
    }

    recipients_work.clear_invalid();

    // CHECK EXISTING USERS FOR EMAIL SHARES
    for ( const recipient_item of recipients_work.list() ) {
        if ( recipient_item.type !== 'email' ) continue;
        const user = await get_user({
            email: recipient_item.value,
        });
        if ( ! user ) continue;
        recipient_item.type = 'username';
        recipient_item.value = user.username;
    }

    recipients_work.clear_invalid();
    
    for ( const item of recipients_work.list() ) {
        if ( item.type !== 'username' ) continue;

        const user = await get_user({ username: item.value });
        if ( ! user ) {
            item.invalid = true;
            result.recipients[item.i] =
                APIError.create('user_does_not_exist', null, {
                    username: item.value,
                });
            continue;
        }
        item.user = user;
    }

    // Return: if there are invalid values in strict mode
    recipients_work.clear_invalid();
    
    // --- Process Paths ---
    
    // Expect: at least one path
    if ( req_shares.length < 1 ) {
        throw APIError.create('field_invalid', null, {
            key: 'shares',
            expected: 'at least one',
            got: 'none',
        })
    }
    
    for ( let i=0 ; i < req_shares.length ; i++ ) {
        const value = req_shares[i];
        shares_work.push({ i, value });
    }
    shares_work.lockin();
    
    for ( const item of shares_work.list() ) {
         const { i } = item;
         let { value } = item;
        
        const thing = lib_typeTagged.process(value);
        if ( thing.$ === 'error' ) {
            item.invalid = true;
            result.shares[i] =
                APIError.create('format_error', null, {
                    message: thing.message
                });
            continue;
        }
        
        const allowed_things = ['fs-share', 'app-share'];
        if ( ! allowed_things.includes(thing.$) ) {
            APIError.create('disallowed_thing', null, {
                thing: thing.$,
                accepted: allowed_things,
            })
        }
        
        if ( thing.$ === 'fs-share' ) {
            item.type = 'fs';
            const errors = [];
            if ( ! thing.path ) {
                errors.push('`path` is required');
            }
            let access = thing.access;
            if ( access ) {
                if ( ! ['read','write'].includes(access) ) {
                    errors.push('`access` should be `read` or `write`');
                }
            } else access = 'read';

            if ( errors.length ) {
                item.invalid = true;
                result.shares[item.i] =
                    APIError.create('field_errors', null, {
                        key: `shares[${item.i}]`,
                        errors
                    });
                continue;
            }
            
            item.path = thing.path;
            item.permission = PermissionUtil.join('fs', thing.path, access);
        }
        
        if ( thing.$ === 'app-share' ) {
            item.type = 'app';
            const errors = [];
            if ( ! thing.uid && thing.name ) {
                errors.push('`uid` or `name` is required');
            }

            if ( errors.length ) {
                item.invalid = true;
                result.shares[item.i] =
                    APIError.create('field_errors', null, {
                        key: `shares[${item.i}]`,
                        errors
                    });
                continue;
            }
            
            item.permission = PermissionUtil.join('app', thing.path, 'access');
            continue;
        }
    }
    
    shares_work.clear_invalid();
    
    for ( const item of shares_work.list() ) {
        if ( item.type !== 'fs' ) continue;
        const node = await (new FSNodeParam('path')).consolidate({
            req, getParam: () => item.path
        });
        
        if ( ! await node.exists() ) {
            item.invalid = true;
            result.shares[item.i] = APIError.create('subject_does_not_exist', {
                path: item.path,
            })
            continue;
        }
        
        item.node = node;
        let email_path = item.path;
        let is_dir = true;
        if ( await node.get('type') !== TYPE_DIRECTORY ) {
            is_dir = false;
            // remove last component
            email_path = email_path.slice(0, item.path.lastIndexOf('/')+1);
        }

        if ( email_path.startsWith('/') ) email_path = email_path.slice(1);
        const email_link = `${config.origin}/show/${email_path}`;
        item.is_dir = is_dir;
        item.email_link = email_link;
    }
    
    shares_work.clear_invalid();

    // Mark files as successful; further errors will be
    // reported on recipients instead.
    for ( const item of shares_work.list() ) {
        result.shares[item.i] =
            {
                $: 'api:status-report',
                status: 'success',
                fields: {
                    permission: item.permission,
                }
            };
    }
    
    if ( strict_check() ) return;
    if ( req.body.dry_run ) {
        // Mark everything left as successful
        for ( const item of recipients_work.list() ) {
            result.recipients[item.i] =
                { $: 'api:status-report', status: 'success' };
        }
        
        result.status = 'success';
        result.dry_run = true;
        serialize_result();
        res.send(result);
        return;
    }
    
    for ( const recipient_item of recipients_work.list() ) {
        if ( recipient_item.type !== 'username' ) continue;
        
        const username = recipient_item.user.username;

        for ( const share_item of shares_work.list() ) {
            await svc_permission.grant_user_user_permission(
                actor,
                username,
                share_item.permission,
            );
        }
        
        // TODO: Need to re-work this for multiple files
        /*
        const email_values = {
            link: recipient_item.email_link,
            susername: req.user.username,
            rusername: username,
        };

        const email_tmpl = 'share_existing_user';

        await svc_email.send_email(
            { email: recipient_item.user.email },
            email_tmpl,
            email_values,
        );
        */
       
        const files = []; {
            for ( const path_item of shares_work.list() ) {
                files.push(
                    await path_item.node.getSafeEntry(),
                );
            }
        }
        
        svc_notification.notify(UsernameNotifSelector(username), {
            source: 'sharing',
            icon: 'shared.svg',
            title: 'Files were shared with you!',
            template: 'file-shared-with-you',
            fields: {
                username: actor.type.user.username,
                files,
            },
            text: `The user ${quot(req.user.username)} shared ` +
                `${files.length} ` +
                (files.length === 1 ? 'file' : 'files') + ' ' +
                'with you.',
        });
        
        result.recipients[recipient_item.i] =
            { $: 'api:status-report', status: 'success' };
    }

    for ( const recipient_item of recipients_work.list() ) {
        if ( recipient_item.type !== 'email' ) continue;
        
        const email = recipient_item.value;
        
        // data that gets stored in the `data` column of the share
        const data = {
            $: 'internal:share',
            $v: 'v0.0.0',
            permissions: [],
        };
        
        for ( const share_item of shares_work.list() ) {
            data.permissions.push(share_item.permission);
        }
        
        // track: scoping iife
        const share_token = await (async () => {
            const share_uid = await svc_share.create_share({
                issuer: actor,
                email,
                data,
            });
            return svc_token.sign('share', {
                $: 'token:share',
                $v: '0.0.0',
                uid: share_uid,
            }, {
                expiresIn: '14d'
            });
        })();
        
        const email_link =
            `${config.origin}?share_token=${share_token}`;
        
        await svc_email.send_email({ email }, 'share_by_email', {
            link: email_link,
        });
    }
    
    result.status = 'success';
    serialize_result(); // might change result.status to 'mixed'
    res.send(result);
};

Endpoint({
    // "item" here means a filesystem node
    route: '/',
    mw: [configurable_auth()],
    methods: ['POST'],
    handler: v0_2,
}).attach(router);

module.exports = app => {
    app.use('/share', router);
};
