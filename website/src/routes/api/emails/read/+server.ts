import { json, error } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, locals }) => {
    if (!locals.user) {
        throw error(401, 'Unauthorized');
    }

    let body;
    let emailId: string;

    try {
        body = await request.json();
        if (!body || typeof body !== 'object') {
            throw new Error('Invalid request body format');
        }

        emailId = body.emailId;
        if (!emailId || (typeof emailId !== 'string' && typeof emailId !== 'number')) {
            throw new Error(`Missing or invalid emailId: ${emailId}`);
        }

        emailId = emailId.toString();
    } catch (err) {
        console.error("Error parsing request body:", err);
        throw error(400, 'Invalid request body');
    }

    const userEmail = `${locals.user.username}#${locals.user.domain}`;

    try {
        const emailInfo = await sql`
            SELECT thread_id, from_address, to_address, self_destruct
            FROM emails
            WHERE id = ${emailId}
              AND (to_address = ${userEmail} OR from_address = ${userEmail})
        `;

        if (emailInfo.count === 0) {
            throw error(404, 'Email not found');
        }

        if (emailInfo[0].self_destruct && emailInfo[0].to_address === userEmail) {
            const deleteResult = await sql`
                DELETE FROM emails
                WHERE (thread_id = ${emailInfo[0].thread_id} OR id = ${emailId})
                  AND (to_address = ${userEmail} OR from_address = ${userEmail})
                RETURNING id
            `;

            return json({
                success: true,
                deleted: deleteResult.count > 0
            });
        }

        const receivedUpdateResult = await sql`
            UPDATE emails
            SET read_at = NOW()
            WHERE
                (thread_id = ${emailInfo[0].thread_id} OR id = ${emailId})
                AND to_address = ${userEmail}
                AND read_at IS NULL
            RETURNING id
        `;

        let totalUpdated = receivedUpdateResult.count;
        if (emailInfo[0].from_address === userEmail) {
            const senderUpdateResult = await sql`
                UPDATE emails
                SET read_at = NOW()
                WHERE id = ${emailId}
                AND read_at IS NULL
                RETURNING id
            `;
            totalUpdated += senderUpdateResult.count;
        }

        return json({
            success: true,
            updated: totalUpdated > 0
        });
    } catch (err) {
        console.error("Database error marking email as read:", err);
        throw error(500, 'Failed to mark email as read');
    }
};