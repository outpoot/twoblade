import { json } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { PUBLIC_DOMAIN } from '$env/static/public';

export async function GET({ params }) {
	const [username, domain] = params.emailAddress.split('#');

	if (!username || !domain) {
		console.warn(`Invalid email address: ${params.emailAddress}`);
		return json({ iq: null }, { status: 400 });
	}

	if (domain !== PUBLIC_DOMAIN) {
		const domainRegex = /^(?:(?!-)[a-zA-Z0-9-]{1,63}(?<!-)\.)+(?:[a-zA-Z0-9-]{2,63})$/;
		if (!domainRegex.test(domain)) {
			return json({ iq: null }, { status: 400 });
		}

		try {
			const response = await fetch(
				`https://${domain}/api/users/${encodeURIComponent(params.emailAddress)}/iq`
			);
			if (response.ok) {
				const data = await response.json();
				return json({ iq: data.iq });
			} else {
				return json({ iq: null }, { status: response.status });
			}
		} catch (error) {
			console.error(`Error fetching user IQ for ${params.emailAddress} (remote):`, error);
			return json({ iq: null }, { status: 500 });
		}
	}

	try {
		const users = await sql`
            SELECT iq
            FROM users
            WHERE username = ${username}
        `;

		if (users.length === 0) {
			return json({ iq: null });
		}

		return json({ iq: users[0].iq });
	} catch (error) {
		console.error(`Error fetching user IQ for ${params.emailAddress}:`, error);
		return json({ iq: null }, { status: 500 });
	}
}
