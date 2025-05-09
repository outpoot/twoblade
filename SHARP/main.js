import express from 'express'
import net from 'net'
import cors from 'cors'
import postgres from 'postgres'
import { resolveSrv, verifySharpDomain } from './dns-utils.js'
import { validateAuthToken } from './middleware/auth.js'
import { createHash } from 'crypto'

const SHARP_PORT = +process.env.SHARP_PORT || 5000
const HTTP_PORT = +process.env.HTTP_PORT || SHARP_PORT + 1
const DOMAIN = process.env.DOMAIN_NAME || 'localhost'
const sql = postgres(process.env.DATABASE_URL)

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

setInterval(async () => {
    try {
        // First, clean up attachments for expired emails
        await sql`
            DELETE FROM attachments
            WHERE email_id IN (
                SELECT id FROM emails
                WHERE expires_at < NOW()
                AND expires_at IS NOT NULL
            )
        `;
        // TODO: remove from S3 too

        // Then delete the expired emails
        await sql`
            DELETE FROM emails
            WHERE expires_at < NOW()
            AND expires_at IS NOT NULL
        `;
    } catch (error) {
        console.error('Error cleaning up expired emails:', error);
    }
}, 10000);

const PROTOCOL_VERSION = 'SHARP/1.2'

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
    TRIVIAL: 5
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
const sendError = (s, e) => {
    sendJSON(s, { type: 'ERROR', message: e })
    s.end()
}

async function handleSharpMessage(socket, raw, state) {
    const MAX_MESSAGE_SIZE = 1 * 1024 * 1024;
    if (raw.length > MAX_MESSAGE_SIZE) {
        sendError(socket, 'Message too large');
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
                const to = parseSharpAddress(state.to)
                const addr = to.port
                    ? `${to.domain}:${to.port}`
                    : to.domain
                if (addr !== DOMAIN) {
                    sendError(
                        socket,
                        `This server does not handle mail for ${to.domain}`
                    )
                    return
                }
                const user = await verifyUser(to.username, DOMAIN)
                if (!user) {
                    sendError(socket, 'Recipient user not found')
                    return
                }
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

async function processEmail({ from, to, subject, body, content_type, html_body, attachments = [] }) {
    const f = parseSharpAddress(from)
    const t = parseSharpAddress(to)
    const emailResult = await logEmail(from, f.domain, to, t.domain, subject, body, content_type, html_body, 'sent')

    if (attachments.length > 0) {
        await sql`
            UPDATE attachments 
            SET email_id = ${emailResult[0].id},
                status = 'sent'
            WHERE key = ANY(${attachments})
        `
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

async function validateRemoteServer(healthCheckHost, expectedDomain, httpPort) {
    const timeout = 5000;
    const healthPort = httpPort || HTTP_PORT;

    for (const proto of ['https://', 'http://']) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);

            const url = `${proto}${healthCheckHost}:${healthPort}/sharp/api/server/health`;
            const res = await fetch(url, { signal: controller.signal });
            clearTimeout(timer);

            if (!res.ok) continue;
            const data = await res.json();

            if (data.protocol === PROTOCOL_VERSION && data.domain === expectedDomain) {
                return { domain: data.domain, protocol: proto, isValid: true };
            }
        } catch { }
    }
    return { isValid: false, error: 'Server not reachable or invalid' };
}

async function sendEmailToRemoteServer(emailData) {
    const recAddr = parseSharpAddress(emailData.to);
    let target, domain, httpPort;

    if (recAddr.port) {
        target = { host: recAddr.domain, port: recAddr.port };
        domain = recAddr.domain;
        httpPort = recAddr.port + 1;
    } else {
        const srv = await resolveSrv(recAddr.domain);
        target = { host: srv.ip, port: srv.port };
        domain = recAddr.domain;
        httpPort = srv.httpPort;
    }

    const validation = await validateRemoteServer(domain, recAddr.domain, httpPort);
    if (!validation.isValid) {
        throw new Error(`Remote server validation failed for ${domain}: ${validation.error}`);
    }

    console.log(`[sendEmailToRemoteServer] dialing TCP ${target.host}:${target.port}`);

    const client = net.createConnection({
        host: target.host,
        port: target.port
    });

    const steps = [
        { type: 'HELLO', server_id: emailData.from, protocol: PROTOCOL_VERSION },
        { type: 'MAIL_TO', address: emailData.to },
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

            responses.push(response);

            if (response.type === 'ERROR') {
                cleanup();
                return reject(new Error(response.message));
            }

            if (response.type === 'OK') {
                if (response.message === 'Email processed') {
                    cleanup();
                    return resolve({ success: true, responses });
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
                    attachments: email.attachments || []
                });
                await sql`
            UPDATE emails
            SET status = 'sent'
            WHERE id = ${email.id}
          `;
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

processScheduledEmails();
setInterval(processScheduledEmails, 60000);

const app = express()
app.use(cors(), express.json())

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

function calculateSpamScore(header, resource) {
    if (!header) return 3;

    try {
        const [version, bits, date, headerResource, ext, rand, counter] = header.split(':');

        if (version !== '1' || !bits || !date || !headerResource || !rand || !counter) {
            return 3;
        }

        // Verify resource matches
        if (headerResource !== resource) {
            return 3;
        }

        // Verify date is within last hour
        const headerDate = parseHashcashDate(date);
        const now = new Date();
        if (now - headerDate > 3600000) {
            return 2;
        }

        // Verify proof of work
        const hash = createHash('sha1')
            .update(header)
            .digest('hex');

        const actualBits = parseInt(bits, 10);

        if (!hasLeadingZeroBits(hash, actualBits)) {
            return 3;
        }

        if (actualBits >= HASHCASH_THRESHOLDS.GOOD) return 0;
        if (actualBits >= HASHCASH_THRESHOLDS.WEAK) return 1;
        if (actualBits >= HASHCASH_THRESHOLDS.TRIVIAL) return 2;
        return 3;
    } catch {
        return 3;
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

app.post('/send', validateAuthToken, async (req, res) => {
    let logEntry;
    let id;
    try {
        const { hashcash, ...emailData } = req.body;
        const { from, to, subject, body, content_type = 'text/plain',
            html_body, scheduled_at, reply_to_id, thread_id,
            attachments = [], expires_at = null, self_destruct = false } = emailData;

        const fp = parseSharpAddress(from);

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

        const spamScore = calculateSpamScore(hashcash, emailData.to);

        if (!hashcash || spamScore >= 3) {
            return res.status(429).json({
                success: false,
                message: `Insufficient proof of work. Please retry with at least ${HASHCASH_THRESHOLDS.TRIVIAL} bits.`
            });
        }

        let status = spamScore > 0 ? 'spam' : 'pending';
        if (emailData.scheduled_at) status = 'scheduled';

        const attachmentKeys = attachments.map(att => att.key).filter(Boolean);
        const tp = parseSharpAddress(to);

        if (scheduled_at) {
            logEntry = await logEmail(from, fp.domain, to, tp.domain, subject, body, content_type, html_body, status, scheduled_at, reply_to_id, thread_id, expires_at, self_destruct);
            id = logEntry[0]?.id;
            if (id && attachmentKeys.length > 0) {
                await sql`UPDATE attachments SET email_id = ${id}, status = ${status} WHERE key = ANY(${attachmentKeys})`;
            }
            return res.json({ success: true, scheduled: true, id });
        }

        if (tp.domain === DOMAIN) {
            if (!await verifyUser(tp.username, tp.domain)) {
                return res.status(404).json({ success: false, message: 'Recipient user not found on this server' });
            }
            const finalStatus = status === 'pending' ? 'sent' : status;
            logEntry = await logEmail(from, fp.domain, to, tp.domain, subject, body, content_type, html_body, finalStatus, null, reply_to_id, thread_id, expires_at, self_destruct);
            id = logEntry[0]?.id;
            if (id && attachmentKeys.length > 0) {
                await sql`UPDATE attachments SET email_id = ${id}, status = ${finalStatus} WHERE key = ANY(${attachmentKeys})`;
            }
            return res.json({ success: true, id });
        }

        try {
            await validateRemoteServer(tp.domain, tp.domain);
        } catch (e) {
            await logEmail(from, fp.domain, to, tp.domain, subject, body, content_type, html_body, 'failed', null, reply_to_id, thread_id, expires_at, self_destruct);
            throw new Error(`Invalid destination: ${e.message}`);
        }

        logEntry = await logEmail(
            from, fp.domain, to, tp.domain, subject, body,
            content_type, html_body, status, scheduled_at,
            reply_to_id, thread_id, expires_at, self_destruct
        );
        id = logEntry[0]?.id;

        if (id && attachmentKeys.length > 0) {
            console.log(`[Remote] Linking ${attachmentKeys.length} attachments to email ID ${id}:`, attachmentKeys);
            await sql`
                UPDATE attachments
                SET email_id = ${id},
                    status = 'sending' // Attachments are 'sending' during remote transfer attempt
                WHERE key = ANY(${attachmentKeys})
            `;
        }

        // Proceed with sending (status could be 'pending' or 'spam')
        try {
            const result = await Promise.race([
                sendEmailToRemoteServer({
                    from, to, subject, body, content_type, html_body,
                    attachments: attachmentKeys
                }),
                new Promise((_, r) => setTimeout(() => {
                    r(new Error('Connection timed out'))
                }, 10000))
            ])

            if (result.responses?.some(r => r.type === 'ERROR')) {
                if (id) {
                    await sql`UPDATE emails SET status='rejected' WHERE id=${id}`;
                    if (attachmentKeys.length > 0) {
                        await sql`UPDATE attachments SET status='rejected' WHERE key = ANY(${attachmentKeys})`;
                    }
                }
                return res.status(400).json({ success: false, message: 'Remote server rejected the email' })
            }

            if (id) {
                // Update status to 'sent' only upon successful remote delivery,
                // even if it was initially marked as 'spam' by the sender.
                // The recipient server will make its own final determination.
                await sql`UPDATE emails SET status='sent', sent_at = NOW() WHERE id=${id}`;
                if (attachmentKeys.length > 0) {
                    await sql`UPDATE attachments SET status='sent' WHERE key = ANY(${attachmentKeys})`;
                }
            }
            return res.json({ ...result, id });
        } catch (e) {
            if (id) {
                await sql`UPDATE emails SET status='failed', error_message=${e.message} WHERE id=${id}`;
                if (attachmentKeys.length > 0) {
                    await sql`UPDATE attachments SET status='failed' WHERE key = ANY(${attachmentKeys})`;
                }
            }
            throw e;
        }
    } catch (e) {
        console.error('Request failed:', e);
        if (id && !(await sql`SELECT 1 FROM emails WHERE id=${id} AND status IN ('failed', 'rejected', 'spam')`)[0]) {
            await sql`UPDATE emails SET status='failed', error_message=${e.message} WHERE id=${id}`;
            const attachmentKeys = req.body.attachments?.map(att => att.key).filter(Boolean) || [];
            if (attachmentKeys.length > 0) {
                await sql`UPDATE attachments SET status='failed' WHERE key = ANY(${attachmentKeys}) AND email_id = ${id}`;
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
        const state = { step: 'HELLO', buffer: '' };

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
