import express from 'express'
import net from 'net'
import cors from 'cors'
import postgres from 'postgres'
import { resolveSrv, verifySharpDomain } from './dns-utils.js'
import { validateAuthToken } from './middleware/auth.js'
import { createHash } from 'crypto'
import path from "path"
import fs from "fs"

const SHARP_PORT = +process.env.SHARP_PORT || 5000
const HTTP_PORT = +process.env.HTTP_PORT || SHARP_PORT + 1
const DOMAIN = process.env.DOMAIN_NAME || 'localhost'

const USERNAME_REGEX = /^[a-zA-Z0-9_\-!$%&'*/?=^@.]+$/;
const MAX_USERNAME_LENGTH = 20;

const sql = postgres(process.env.DATABASE_URL)

const PROTOCOL_VERSION = 'SHARP/1.3'

const KEYWORDS = {
    promotions: new Set([
        'sale', 'discount', 'buy now', 'limited time', 'offer',
        'free shipping', 'coupon', 'deal', 'save', 'special'
    ]),
    social: new Set([
        'friend request', 'mentioned you', 'liked your post',
        'new follower', 'connection', 'following'
    ]),
    forums: new Set([
        'digest', 'thread', 'post reply', 'new topic',
        'unsubscribe from this group', 'mailing list'
    ]),
    updates: new Set([
        'receipt', 'order confirmation', 'invoice',
        'payment received', 'shipping update', 'account update'
    ])
};

const HASHCASH_THRESHOLDS = {
    GOOD: 18,
    WEAK: 10,
    TRIVIAL: 5,
    REJECT: 3
};

const verifyUser = (u, d) =>
    sql`SELECT * FROM users WHERE username=${u} AND domain=${d}`.then(r => r[0])
const logEmail = (fa, fd, ta, td, s, b, ct = 'text/plain', hb = null, st = 'pending', sa = null, rid = null, tid = null, ea = null, sd = false) => {
    const classification = classifyEmail(s, b, hb);
    return sql`
        INSERT INTO emails (
            from_address, from_domain, to_address, to_domain, 
            subject, body, content_type, html_body, status, 
            scheduled_at, classification, reply_to_id, thread_id,
            expires_at, self_destruct
        ) 
        VALUES (
            ${fa}, ${fd}, ${ta}, ${td}, ${s}, ${b}, ${ct}, 
            ${hb}, ${st}, ${sa}, ${classification}, ${rid}, ${tid},
            ${ea}, ${sd}
        ) 
        RETURNING id
    `;
}

const parseSharpAddress = a => {
    const m = a.match(/^(.+)#([^:]+)(?::(\d+))?$/);
    if (!m) throw new Error('Invalid SHARP address format');
    return { username: m[1].toLowerCase(), domain: m[2].toLowerCase(), port: m[3] && +m[3] };
};

const sendJSON = (s, m) => s.writable && s.write(JSON.stringify(m) + '\n')
const sendError = (s, e, code = 400) => {
    sendJSON(s, { type: 'ERROR', message: e, code })
    s.end()
}

function isValidSharpUsername(username) {
    if (!username || username.length === 0 || username.length > MAX_USERNAME_LENGTH) {
        return false;
    }
    if (!USERNAME_REGEX.test(username)) {
        return false;
    }
    return true;
}

async function handleSharpMessage(socket, raw, state) {
    const MAX_MESSAGE_SIZE = 1 * 1024 * 1024;
    if (raw.length > MAX_MESSAGE_SIZE) {
        sendError(socket, 'Message too large', 413);
        return;
    }

    try {
        const cmd = JSON.parse(raw.replace(/\r$/, ''));
        switch (state.step) {
            case 'HELLO':
                if (cmd.type !== 'HELLO') {
                    sendError(socket, 'Expected HELLO')
                    return
                }
                if (cmd.protocol !== PROTOCOL_VERSION) {
                    sendError(socket, `Unsupported protocol version: ${cmd.protocol}`)
                    return
                }

                try {
                    const parsedFrom = parseSharpAddress(cmd.server_id);
                    if (!isValidSharpUsername(parsedFrom.username)) {
                        sendError(socket, `Invalid username format in server_id.`);
                        return;
                    }
                    await verifySharpDomain(parsedFrom.domain, socket.remoteAddress);
                    state.from = cmd.server_id;
                    state.step = 'MAIL_TO';
                    sendJSON(socket, { type: 'OK', protocol: PROTOCOL_VERSION });
                } catch (e) {
                    sendError(socket, `Sender verification failed: ${e.message}`);
                }
                return

            case 'MAIL_TO':
                if (cmd.type !== 'MAIL_TO') {
                    sendError(socket, 'Expected MAIL_TO')
                    return
                }
                state.to = cmd.address
                let to;
                try {
                    to = parseSharpAddress(state.to);
                } catch (e) {
                    sendError(socket, `Invalid recipient address format: ${e.message}`);
                    return;
                }

                if (!isValidSharpUsername(to.username)) {
                    sendError(socket, `Invalid username format in recipient address.`);
                    return;
                }

                const addr = to.port
                    ? `${to.domain}:${to.port}`
                    : to.domain
                if (addr !== DOMAIN) {
                    sendError(socket, `This server does not handle mail for ${to.domain}`, 451)
                    return
                }
                const user = await verifyUser(to.username, DOMAIN)
                if (!user) {
                    sendError(socket, 'Recipient user not found', 550)
                    return
                }

                // Inter-server hashcash check
                if (!cmd.hashcash) {
                    sendError(socket, 'Missing X-Hashcash header or hashcash field', 429);
                    return;
                }
                const spamScore = await calculateSpamScore(cmd.hashcash, state.to);
                if (spamScore >= HASHCASH_THRESHOLDS.REJECT) {
                    sendError(socket, `Insufficient proof of work. Score: ${spamScore}`, 429);
                    return;
                }
                state.hashcash = cmd.hashcash;

                state.step = 'DATA'
                sendJSON(socket, { type: 'OK' })
                return

            case 'DATA':
                if (cmd.type !== 'DATA') {
                    sendError(socket, 'Expected DATA')
                    return
                }
                state.step = 'RECEIVING_DATA'
                sendJSON(socket, { type: 'OK' })
                return

            case 'RECEIVING_DATA':
                if (cmd.type === 'EMAIL_CONTENT') {
                    state.subject = cmd.subject;
                    state.body = cmd.body;
                    state.content_type = cmd.content_type || 'text/plain';
                    state.html_body = cmd.html_body || null;
                    state.attachments = cmd.attachments || [];

                    sendJSON(socket, { type: 'OK', message: 'Email content received' });
                } else if (cmd.type === 'END_DATA') {
                    await processEmail(state);
                    sendJSON(socket, { type: 'OK', message: 'Email processed' });
                    socket.end();
                } else {
                    sendError(socket, 'Expected EMAIL_CONTENT or END_DATA');
                }
                return;

            default:
                sendError(socket, `Unhandled state: ${state.step}`)
        }
    } catch {
        sendError(socket, 'Invalid message format or processing error')
    }
}

async function processEmail({ from, to, subject, body, content_type, html_body, attachments = [], hashcash }) {
    const f = parseSharpAddress(from)
    const t = parseSharpAddress(to)
    const emailResult = await logEmail(from, f.domain, to, t.domain, subject, body, content_type, html_body, 'sent')
    const emailId = emailResult[0]?.id;

    if (emailId && hashcash) {
        try {
            const hashcashDate = parseHashcashDate(hashcash.split(':')[2]);
            const tokenExpiry = new Date(hashcashDate.getTime() + 24 * 60 * 60 * 1000);
            await sql`INSERT INTO used_hashcash_tokens (token, expires_at) VALUES (${hashcash}, ${tokenExpiry}) ON CONFLICT (token) DO NOTHING`;
        } catch (e) {
            console.error(`Failed to log used hashcash token ${hashcash} for SHARP email ${emailId}:`, e);
        }
    }

    if (emailId && attachments.length > 0) {
        await sql`
            UPDATE attachments 
            SET email_id = ${emailId},
                status = 'sent'
            WHERE key = ANY(${attachments})
        `;
    }
}

function classifyEmail(subject, body, htmlBody) {
    const fullText = `${subject || ''} ${body || ''}`.toLowerCase();

    const scores = {
        promotions: 0,
        social: 0,
        forums: 0,
        updates: 0
    };

    for (const [category, keywords] of Object.entries(KEYWORDS)) {
        for (const keyword of keywords) {
            if (fullText.includes(keyword.toLowerCase())) {
                scores[category]++;
            }
        }
    }

    // HTML structure score for promotions
    if (htmlBody) {
        const htmlScore = (htmlBody.match(/<img/g) || []).length +
            (htmlBody.match(/<table/g) || []).length +
            (htmlBody.match(/<style/g) || []).length;
        scores.promotions += Math.min(htmlScore, 5);
    }

    // find category with highest score
    const maxScore = Math.max(...Object.values(scores));
    if (maxScore > 0) {
        return Object.entries(scores)
            .find(([_, score]) => score === maxScore)?.[0] || 'primary';
    }

    return 'primary';
}

async function sendEmailToRemoteServer(emailData) {
    const recAddr = parseSharpAddress(emailData.to);
    let target;

    if (recAddr.port) {
        target = { host: recAddr.domain, port: recAddr.port };
    } else {
        const srv = await resolveSrv(recAddr.domain);
        target = { host: srv.ip, port: srv.port };
    }

    console.log(`[sendEmailToRemoteServer] dialing TCP ${target.host}:${target.port}`);

    const client = net.createConnection({
        host: target.host,
        port: target.port
    });

    const steps = [
        { type: 'HELLO', server_id: emailData.from, protocol: PROTOCOL_VERSION },
        { type: 'MAIL_TO', address: emailData.to, hashcash: emailData.hashcash },
        { type: 'DATA' },
        {
            type: 'EMAIL_CONTENT',
            subject: emailData.subject,
            body: emailData.body,
            content_type: emailData.content_type,
            html_body: emailData.html_body,
            attachments: emailData.attachments || []
        },
        { type: 'END_DATA' }
    ];

    return new Promise((resolve, reject) => {
        const responses = [];
        let stepIndex = 0;
        let timeout;

        const cleanup = () => {
            clearTimeout(timeout);
            client.removeAllListeners();
            client.destroy();
        };

        const handleResponse = (line) => {
            console.log('[sendEmailToRemoteServer] recv', line.trim());
            let response;
            try {
                response = JSON.parse(line);
            } catch {
                cleanup();
                return reject(new Error('Invalid JSON from remote'));
            }

            if (response.type === 'ERROR') {
                cleanup();
                return reject(new Error(response.message));
            }

            if (response.type === 'OK') {
                if (response.message === 'Email processed') {
                    cleanup();
                    return resolve({ success: true, responses });
                }

                if (response.message === 'Email content received') {
                    return;
                }

                sendNextMessage();
            }
        };

        const sendMessage = (message) => {
            console.log('[sendEmailToRemoteServer] send', JSON.stringify(message));
            client.write(JSON.stringify(message) + '\n');
        };

        const sendNextMessage = () => {
            if (stepIndex < steps.length) {
                const message = steps[stepIndex++];
                sendMessage(message);

                if (message.type === 'EMAIL_CONTENT' && steps[stepIndex]?.type === 'END_DATA') {
                    sendMessage(steps[stepIndex]);
                    stepIndex++;
                }
            } else {
                cleanup();
                reject(new Error('Unexpected state: No more messages to send.'));
            }
        };

        client.on('connect', () => {
            clearTimeout(timeout);
            sendNextMessage();
        });

        client.on('data', (chunk) => {
            const lines = chunk.toString().split('\n').filter(Boolean);
            lines.forEach(handleResponse);
        });

        client.on('error', (err) => {
            cleanup();
            reject(new Error(`Socket error: ${err.message}`));
        });

        client.on('close', (hadError) => {
            if (hadError) {
                return;
            }
            cleanup();
            reject(new Error('Connection closed unexpectedly'));
        });

        timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Connection timed out'));
        }, 10000);
    });
}

async function processScheduledEmails() {
    try {
        const emails = await sql`
        SELECT * FROM emails 
        WHERE status = 'scheduled'
          AND scheduled_at IS NOT NULL
          AND scheduled_at <= CURRENT_TIMESTAMP
        ORDER BY scheduled_at ASC
        LIMIT 10
      `;
        for (const email of emails) {
            console.log(`Processing scheduled email ID ${email.id} scheduled for ${email.scheduled_at}`);
            await sql`
          UPDATE emails
          SET status = 'sending',
              sent_at = NOW()
          WHERE id = ${email.id}
        `;
            const to = parseSharpAddress(email.to_address);
            if (to.domain === DOMAIN) {
                await sql`
            UPDATE emails
            SET status = 'sent'
            WHERE id = ${email.id}
          `;
                console.log(
                    `Locally delivered scheduled email ID ${email.id}`
                );
                continue;
            }
            try {
                await sendEmailToRemoteServer({
                    from: email.from_address,
                    to: email.to_address,
                    subject: email.subject,
                    body: email.body,
                    content_type: email.content_type,
                    html_body: email.html_body,
                    attachments: email.attachments || [],
                    // placeholder.
                    // scheduled emails are not sent with hashcash
                    // they are already sent as "spam" instantly, without scheduling, if weak hashcash
                    // hashcash: hashcash(email.to_address)
                });
                await sql`UPDATE emails SET status = 'sent' WHERE id = ${email.id}`;
                console.log(
                    `Successfully sent scheduled email ID ${email.id}`
                );
            } catch (error) {
                console.error(
                    `Failed to send scheduled email ID ${email.id}:`,
                    error
                );
                await sql`
            UPDATE emails
            SET status = 'failed',
                error_message = ${error.message}
            WHERE id = ${email.id}
          `;
            }
        }
    } catch (error) {
        console.error('Error processing scheduled emails:', error);
    }
}

function parseHashcashDate(dateString) {
    const year = parseInt(dateString.substring(0, 2), 10) + 2000;
    const month = parseInt(dateString.substring(2, 4), 10) - 1; // Month is 0-indexed
    const day = parseInt(dateString.substring(4, 6), 10);
    const hour = parseInt(dateString.substring(6, 8), 10);
    const minute = parseInt(dateString.substring(8, 10), 10);
    const second = parseInt(dateString.substring(10, 12), 10);

    return new Date(year, month, day, hour, minute, second);
}

function hasLeadingZeroBits(hexHash, bits) {
    if (bits === 0) return true;
    if (bits > hexHash.length * 4) {
        return false;
    }

    const hashInt = BigInt('0x' + hexHash);
    const shiftAmount = BigInt(160 - bits);
    return (hashInt >> shiftAmount) === 0n;
}

async function calculateSpamScore(header, resource) {
    if (!header) return HASHCASH_THRESHOLDS.REJECT;

    try {
        const [version, bits, date, headerResource, ext, rand, counter] = header.split(':');

        if (version !== '1' || !bits || !date || !headerResource || !rand || !counter) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        // Verify resource matches
        if (headerResource !== resource) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        const headerDate = parseHashcashDate(date);
        const now = new Date();
        const offset = 2 * 60 * 1000;

        if (headerDate > new Date(now.getTime() + offset)) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        if (now - headerDate > 3600000) {
            return HASHCASH_THRESHOLDS.WEAK + 1;
        }

        const existingToken = await sql`SELECT 1 FROM used_hashcash_tokens WHERE token = ${header}`;
        if (existingToken.length > 0) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        // Verify proof of work
        const hash = createHash('sha1')
            .update(header)
            .digest('hex');

        const actualBits = parseInt(bits, 10);

        if (!hasLeadingZeroBits(hash, actualBits)) {
            return HASHCASH_THRESHOLDS.REJECT;
        }

        if (actualBits >= HASHCASH_THRESHOLDS.GOOD) return 0;
        if (actualBits >= HASHCASH_THRESHOLDS.WEAK) return 1;
        if (actualBits >= HASHCASH_THRESHOLDS.TRIVIAL) return 2;
        return HASHCASH_THRESHOLDS.REJECT;
    } catch {
        return HASHCASH_THRESHOLDS.REJECT;
    }
}

function checkVocabulary(text, iq) {
    let maxWordLength;

    if (iq < 90) maxWordLength = 3;
    else if (iq < 100) maxWordLength = 4;
    else if (iq < 120) maxWordLength = 5;
    else if (iq < 130) maxWordLength = 6;
    else if (iq < 140) maxWordLength = 7;
    else return { isValid: true, limit: null };

    const words = text.split(/\s+/);
    for (const word of words) {
        const cleanedWord = word.replace(/[.,!?;:"']/g, '');
        if (cleanedWord.length > maxWordLength) {
            return { isValid: false, limit: maxWordLength };
        }
    }
    return { isValid: true, limit: maxWordLength };
}

const MIGRATIONS_INIT_MIGRATION =  {file:"00_migration_table.sql", id: "00_migration_table"} // this needs to be run first, as it creates the migrations table, it is also not noted in the migrations table itself, the existence of the table is the hypotetical entry in it

const MIGRATIONS = [
    {
        description: "add two new fields to the users table",
        file: "5-20-2025.sql",
        id: "5-20-2025",
        needsMigration : async ()=>{
            const tables =  await sql`
                SELECT * 
                FROM information_schema.columns 
                WHERE table_schema = 'public' 
                AND table_name='users'
                AND column_name= 'ip';
            `

            // no ip column is present
            return tables.length === 0;
        }
    },
    {
        description: "add table for new hashcash features",
        file: "5-21.2025.sql",
        id: "5-21.2025",
                needsMigration : async ()=>{
                    const tablePresent =  await tableExists("used_hashcash_tokens")

                    // table 'used_hashcash_tokens' is not present
                    return !tablePresent
                }
    },

]

async function getMigrationStatus(id){

    const migration = await sql`
        SELECT * FROM migrations 
        WHERE id = ${id}
    `;

    if(migration.length == 0){
        return undefined;
    }

    return migration[0].status;

}

async function createMigrationStatus(id){
    await sql`
        INSERT INTO migrations (id, status)
        VALUES (${id}, 'scheduled')
    `;
}

async function setMigrationStatus(id, status){
    await sql`
            UPDATE migrations 
            SET status = ${status}
            WHERE keidy = ${id}
        `;
}

async function runSingleMigration(migrationsDir, migration, updateStatus = true){

    const setMigrationStatusHelper = async (id, status) => {
        if(!updateStatus){
            return;
        }

        await setMigrationStatus(id, status)

    }

    const {file, id, needsMigration, description} = migration;

    // undefined means, no entry with that id was found
    const migrationStatus = updateStatus ? await getMigrationStatus(id) : null


    if(migrationStatus === undefined){
        await createMigrationStatus(id)
    }else if(migrationStatus === null){
        // do nothing, updateStatus is set to false
    }else if(migrationStatus !== "scheduled"){
        // migration was already executed
        return "skipped"
    }

    setMigrationStatusHelper(id, "running");

    const finalFile = path.join(migrationsDir, file)

    try{

        // if we didn't have a status and there is a function that checks if the migration is needed, run it
        if( (migrationStatus === undefined || migrationStatus === null) && needsMigration !== undefined && typeof needsMigration === "function"){

            const result = await needsMigration();

            // if no migration is needed, set it as migrated and return
            if(!result){
                await setMigrationStatusHelper(id, "migrated");

                return "ok";
            }

        }

        if(!fs.existsSync(finalFile)){
            throw new Error("Migrations file that was manually specified doesn't exist'")
        }

        await sql.file(finalFile)
        
        await setMigrationStatusHelper(id, "migrated")

        return "ok"
    }catch(err){
        console.warn(`An error occurred while running migration with id: '${id}' and description: ${description}`, err)

        await setMigrationStatusHelper(id, "failed")
        return "error";
    }

}

async function tableExists(table, schema = "public"){

    const tables = await sql`
        SELECT * 
        FROM information_schema.tables 
        WHERE table_schema = ${schema} 
        AND table_name = ${table}
        `;

    return tables.length !== 0

}

async function createMigrationTableIfNotExists(migrationsDir){

    const migrationTableExists = await tableExists('migrations')


    if(migrationTableExists){
        return 
    }

    await runSingleMigration(migrationsDir,MIGRATIONS_INIT_MIGRATION, false)

}

async function runMigrations(){

    const migrationsDir = "/migrations/"

    if(!fs.existsSync(migrationsDir)){
        console.warn("Migrations folder not mapped correctly, aborting migrations")
        return;
    }

    console.log("Running migrations")

    await createMigrationTableIfNotExists(migrationsDir);

    const results = {"ok": 0, "error": 0, "skipped": 0}

    for(const migration of MIGRATIONS){
        const result = await runSingleMigration(migrationsDir, migration)
        results[result] += 1
    }

    console.log(`Migrations Result: ${MIGRATIONS.length} Ok: ${results.ok} Error: ${results.error} Skipped: ${results.skipped}`)
}

function startIntervals(){
    // Cleanup for pending emails
    setInterval(async () => {
        try {
            await sql`
                UPDATE emails 
                SET status = 'failed',
                    error_message = 'Timed out while pending'
                WHERE status = 'pending' 
                AND sent_at < NOW() - INTERVAL '30 seconds'
            `;
        } catch (error) {
            console.error('Error updating stale pending emails:', error);
        }
    }, 10000);

    // Cleanup for expired emails
    setInterval(async () => {
        try {
            const toDelete = await sql`
            WITH RECURSIVE to_delete AS (
                SELECT id
                FROM emails
                WHERE expires_at < NOW()
                    AND expires_at IS NOT NULL
                UNION ALL
                SELECT e.id
                FROM emails e
                JOIN to_delete td ON e.reply_to_id = td.id
            )
            SELECT id FROM to_delete
            `;

            if (toDelete.length > 0) {
                const ids = toDelete.map(r => r.id);
                await sql`
                    DELETE FROM attachments
                    WHERE email_id = ANY(${ids})
                `;
                await sql`
                    DELETE FROM emails
                    WHERE id = ANY(${ids})
                `;
            }
        } catch (error) {
            console.error('Error cleaning up expired emails:', error);
        }
    }, 10000);

    // Cleanup for used hashcash tokens
    setInterval(async () => {
        try {
            const result = await sql`
                DELETE FROM used_hashcash_tokens
                WHERE expires_at < NOW()
            `;
            if (result.count > 0) {
                console.log(`Cleaned up ${result.count} expired hashcash tokens.`);
            }
        } catch (error) {
            console.error('Error cleaning up used hashcash tokens:', error);
        }
    }, 3600000); // Run every hour


    processScheduledEmails();
    setInterval(processScheduledEmails, 60000);

}

async function main(){
    await runMigrations()

    startIntervals()

    const app = express()
    app.use(cors(), express.json())


    app.post('/send', validateAuthToken, async (req, res) => {
        let logEntry;
        let emailId;
        try {
            const { hashcash, ...emailData } = req.body;

            let fp, tp;
            try {
                fp = parseSharpAddress(emailData.from);
                tp = parseSharpAddress(emailData.to);
            } catch {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid SHARP address format'
                });
            }

            if (!req.turnstileVerified) {
                return res.status(403).json({
                    success: false,
                    message: 'Turnstile verification failed. Please try again.'
                });
            }

            const spamScore = await calculateSpamScore(hashcash, emailData.to);
            let status = 'pending';

            if (!hashcash || spamScore >= HASHCASH_THRESHOLDS.REJECT) {
                return res.status(429).json({
                    success: false,
                    message: `Insufficient proof of work or invalid/reused token. Required: ${HASHCASH_THRESHOLDS.TRIVIAL} bits. Score: ${spamScore}.`
                });
            }

            if (spamScore > 0) {
                status = 'spam';
            }

            if (emailData.scheduled_at && status !== 'spam') {
                status = 'scheduled';
            }

            const { from, to, subject, body, content_type = 'text/plain',
                html_body, scheduled_at, reply_to_id, thread_id,
                attachments = [], expires_at = null, self_destruct = false } = emailData;

            if (fp.username !== req.user.username || fp.domain !== req.user.domain) {
                return res.status(403).json({
                    success: false,
                    message: 'You can only send emails from your own address.'
                });
            }

            if (fp.domain !== DOMAIN) {
                return res.status(403).json({
                    success: false,
                    message: `This server does not relay mail for the domain ${fp.domain}`
                });
            }

            if (emailData.content_type === 'text/plain' && emailData.body) {
                const users = await sql`SELECT iq FROM users WHERE username = ${req.user.username}`;
                const userIQ = users[0]?.iq;
                const { isValid, limit } = checkVocabulary(emailData.body, userIQ);
                if (!isValid) {
                    return res.status(400).json({
                        success: false,
                        message: `Message contains words longer than the allowed ${limit} characters for your IQ level (${userIQ}). Please simplify.`
                    });
                }
            }

            if (hashcash && spamScore < HASHCASH_THRESHOLDS.REJECT) {
                try {
                    const hashcashDate = parseHashcashDate(hashcash.split(':')[2]);

                    const tokenExpiry = new Date(hashcashDate.getTime() + 24 * 60 * 60 * 1000);
                    await sql`INSERT INTO used_hashcash_tokens (token, expires_at) VALUES (${hashcash}, ${tokenExpiry}) ON CONFLICT (token) DO NOTHING`;
                } catch (e) {
                    console.error(`Failed to log used hashcash token ${hashcash} for /send:`, e);
                    // proceed with email sending
                }
            }

            const attachmentKeys = attachments.map(att => att.key).filter(Boolean);

            if (scheduled_at && status === 'scheduled') {
                logEntry = await logEmail(from, fp.domain, to, tp.domain, subject, body, content_type, html_body, status, scheduled_at, reply_to_id, thread_id, expires_at, self_destruct);
                emailId = logEntry[0]?.id;
                if (emailId && attachmentKeys.length > 0) {
                    await sql`UPDATE attachments SET email_id = ${emailId}, status = ${status} WHERE key = ANY(${attachmentKeys})`;
                }
                return res.json({ success: true, scheduled: true, id: emailId });
            }

            if (tp.domain === DOMAIN) {
                if (!await verifyUser(tp.username, tp.domain)) {
                    return res.status(404).json({ success: false, message: 'Recipient user not found on this server' });
                }
                const finalStatus = status === 'pending' ? 'sent' : status;
                logEntry = await logEmail(from, fp.domain, to, tp.domain, subject, body, content_type, html_body, finalStatus, null, reply_to_id, thread_id, expires_at, self_destruct);
                emailId = logEntry[0]?.id;
                if (emailId && attachmentKeys.length > 0) {
                    await sql`UPDATE attachments SET email_id = ${emailId}, status = ${finalStatus} WHERE key = ANY(${attachmentKeys})`;
                }
                return res.json({ success: true, id: emailId });
            }

            logEntry = await logEmail(
                from, fp.domain, to, tp.domain, subject, body,
                content_type, html_body, status, scheduled_at,
                reply_to_id, thread_id, expires_at, self_destruct
            );
            emailId = logEntry[0]?.id;

            if (emailId && attachmentKeys.length > 0) {
                console.log(`[Remote] Linking ${attachmentKeys.length} attachments to email ID ${emailId}:`, attachmentKeys);
                await sql`
                    UPDATE attachments
                    SET email_id = ${emailId},
                        status = 'sending' 
                    WHERE key = ANY(${attachmentKeys})
                `;
            }

            // don't attempt remote delivery, just store as spam
            if (status === 'spam') {
                if (emailId) {
                    await sql`UPDATE emails SET status='spam' WHERE id=${emailId}`;
                    if (attachmentKeys.length > 0) {
                        await sql`UPDATE attachments SET status='spam' WHERE email_id = ${emailId}`;
                    }
                }
                return res.json({ success: true, id: emailId, message: "Email marked as spam due to low PoW or Turnstile policy." });
            }


            try {
                const result = await Promise.race([
                    sendEmailToRemoteServer({
                        from, to, subject, body, content_type, html_body,
                        attachments: attachmentKeys,
                        hashcash: hashcash
                    }),
                    new Promise((_, r) => setTimeout(() => {
                        r(new Error('Connection timed out'))
                    }, 10000))
                ])

                if (result.responses?.some(r => r.type === 'ERROR')) {
                    if (emailId) {
                        await sql`UPDATE emails SET status='rejected', error_message = ${result.responses.find(r => r.type === 'ERROR')?.message || 'Remote server rejected'} WHERE id=${emailId}`;
                        if (attachmentKeys.length > 0) {
                            await sql`UPDATE attachments SET status='rejected' WHERE key = ANY(${attachmentKeys})`;
                        }
                    }
                    return res.status(400).json({ success: false, message: 'Remote server rejected the email' })
                }

                if (emailId) {
                    // Update status to 'sent' only upon successful remote delivery,
                    // even if it was initially marked as 'spam' by the sender.
                    // The recipient server will make its own final determination.
                    await sql`UPDATE emails SET status='sent', sent_at = NOW() WHERE id=${emailId}`;
                    if (attachmentKeys.length > 0) {
                        await sql`UPDATE attachments SET status='sent' WHERE key = ANY(${attachmentKeys})`;
                    }
                }
                return res.json({ ...result, id: emailId });
            } catch (e) {
                if (emailId) {
                    await sql`UPDATE emails SET status='failed', error_message=${e.message} WHERE id=${emailId}`;
                    if (attachmentKeys.length > 0) {
                        await sql`UPDATE attachments SET status='failed' WHERE key = ANY(${attachmentKeys})`;
                    }
                }
                throw e;
            }
        } catch (e) {
            console.error('Request failed:', e);
            if (emailId) {
                const checkStatus = await sql`SELECT status FROM emails WHERE id=${emailId}`;
                if (checkStatus.length > 0 && !['failed', 'rejected', 'spam'].includes(checkStatus[0].status)) {
                    await sql`UPDATE emails SET status='failed', error_message=${e.message} WHERE id=${emailId}`;
                    const attachmentKeys = req.body.attachments?.map(att => att.key).filter(Boolean) || [];
                    if (attachmentKeys.length > 0) {
                        await sql`UPDATE attachments SET status='failed' WHERE email_id = ${emailId}`;
                    }
                }
            }
            return res.status(400).json({ success: false, message: e.message })
        }
    })

    app.get('/server/health', (_, res) =>
        res.json({
            status: 'ok',
            protocol: PROTOCOL_VERSION,
            domain: DOMAIN,
            hashcash: {
                minBits: HASHCASH_THRESHOLDS.TRIVIAL,
                recommendedBits: HASHCASH_THRESHOLDS.GOOD
            }
        })
    )

    net
        .createServer(socket => {
            const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10MB total buffer limit
            const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
            const state = { step: 'HELLO', buffer: '', hashcash: null };

            socket.on('data', d => {
                if (state.buffer.length + d.length > MAX_BUFFER_SIZE) {
                    console.error(`Buffer overflow attempt from ${remoteAddress}`);
                    sendError(socket, 'Maximum message size exceeded');
                    socket.destroy();
                    return;
                }

                state.buffer += d;
                let idx;
                while ((idx = state.buffer.indexOf('\n')) > -1) {
                    const line = state.buffer.slice(0, idx).replace(/\r$/, '');
                    state.buffer = state.buffer.slice(idx + 1);
                    if (line.trim().length > 0) {
                        handleSharpMessage(socket, line, state);
                    }
                }
            });

            socket.on('error', (err) => {
                console.error(`Socket error from ${remoteAddress}:`, err);
            });
            socket.on('end', () => {
                console.log(`Connection ended from ${remoteAddress}`);
            });
            socket.on('close', (hadError) => {
                console.log(`Connection closed from ${remoteAddress}. Had error: ${hadError}`);
            });
        })
        .listen(SHARP_PORT, () => {
            console.log(
                `SHARP TCP server listening on port ${SHARP_PORT} ` +
                `(HTTP on ${HTTP_PORT})`
            )
            console.log(`Server address format: user#${DOMAIN}:${SHARP_PORT}`)
        })

    app.listen(HTTP_PORT, () => {
        console.log(`HTTP server listening on port ${HTTP_PORT}`)
    })
}

main()
