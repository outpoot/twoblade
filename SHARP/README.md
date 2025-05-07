# SHARP (Self-Hosted Address Routing Protocol) Server

This server implements the SHARP protocol, a decentralized email system that uses `#` symbols for addressing (e.g., `user#domain.com`).

## Protocol Details

- **Version:** SHARP/1.0
- **Transport:** TCP with JSON messages
- **Default Ports:** 5000 (SHARP), 5001 (HTTP API)

### Message Exchange Flow

1. **Connection Establishment**

   ```json
   // Client -> Server
   { "type": "HELLO", "server_id": "sender#domain.com", "protocol": "SHARP/1.0" }
   // Server -> Client
   { "type": "OK", "protocol": "SHARP/1.0" }
   ```

2. **Mail Delivery**

   ```json
   // Client -> Server
   { "type": "MAIL_TO", "address": "recipient#domain.com" }
   // Server -> Client
   { "type": "OK" }
   ```

3. **Content Transfer**
   ```json
   // Client -> Server
   { "type": "DATA" }
   // Server -> Client
   { "type": "OK" }
   // Client -> Server
   {
     "type": "EMAIL_CONTENT",
     "subject": "Subject line",
     "body": "Message body",
     "content_type": "text/plain",
     "html_body": null,
     "attachments": []
   }
   // Client -> Server
   { "type": "END_DATA" }
   // Server -> Client
   { "type": "OK", "message": "Email processed" }
   ```

### Anti-Spam Features

- **Hashcash Proof-of-Work**

  - Minimum bits: 5
  - Recommended bits: 18
  - Weak threshold: 10

- **IQ-based Word Length Limits**
  - IQ < 90: 3 characters
  - IQ < 100: 4 characters
  - IQ < 120: 5 characters
  - IQ < 130: 6 characters
  - IQ < 140: 7 characters
  - IQ ≥ 140: No limit

### Message Classification

Messages are automatically classified into categories:

- Primary
- Promotions
- Social
- Forums
- Updates

## Key Features

- **Decentralized Addressing:** Uses `#` symbol for addressing, allowing users to have addresses tied to their own domains.
- **Self-Hosting:** Allows users to host their own email servers and control their data.

## Running the Server

1.  **Navigate to the `SHARP` directory:**

    ```bash
    cd SHARP
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Run the initialization script:**

    ```bash
    bash ./database/init.sh
    ```

    - This script will prompt you for your domain name and PostgreSQL password.
    - It will create a `.env` file with the necessary environment variables.

4.  **Configure the `docker-compose.yml` file:**

    - Navigate to the `SHARP/database` directory.
    - Edit the `docker-compose.yml` file to set the `POSTGRES_PASSWORD` environment variable.

      ```yaml
      version: '3.8'

      services:
        postgres_db:
          ...
          environment:
            POSTGRES_USER: postgres
            POSTGRES_PASSWORD: REPLACE_ME  # Replace with your desired password
          ...
      ```

5.  **Start the database:**

    ```bash
    cd SHARP/database
    docker compose up -d
    ```

6.  **Initialize the database schema:**

    ```bash
    docker exec -i postgres-db psql -U postgres < init.sql
    ```

7.  **Set up environment variables:**

    - Create a `.env` file in the `SHARP` directory.
    - Add the following variables, replacing the values with your actual configuration:

      ```
      DATABASE_URL=postgres://user:password@host:port/database
      SHARP_PORT=5000
      HTTP_PORT=5001
      DOMAIN_NAME=yourdomain.com
      ```

8.  **Run the server:**

    ```bash
    node main.js
    ```

9.  **Add SRV records to Cloudflare (or your DNS provider):**

    - After setting up the SHARP server, you need to add SRV records to your domain's DNS settings so that other SHARP users can discover your server.
    - These records should point to your server's address and port. The specific records depend on your configuration, but here's an example:

      ```
      _sharp._tcp.yourdomain.com. 86400 IN SRV 10 0 5000 yourdomain.com.
      ```

    - Replace `yourdomain.com` with your actual domain name and `5000` with the port your SHARP server is running on (defined by `SHARP_PORT` in your `.env` file).
    - Consult your DNS provider's documentation for specific instructions on adding SRV records. For Cloudflare, you can typically add these records in the DNS settings panel.

## SHARP Addresses

SHARP uses addresses in the format `user#domain.com`.

- `user` is the username of the recipient.
- `domain.com` is the domain name of the SHARP server.

## Configuration

Besides configuration available through the `.env` file, some core protocol and behavior settings are defined as constants in `SHARP/main.js`:

```javascript
const PROTOCOL_VERSION = "SHARP/1.0";

const KEYWORDS = {
  promotions: new Set([
    /* ...keywords... */
  ]),
  social: new Set([
    /* ...keywords... */
  ]),
  forums: new Set([
    /* ...keywords... */
  ]),
  updates: new Set([
    /* ...keywords... */
  ]),
};

const HASHCASH_THRESHOLDS = {
  GOOD: 18,
  WEAK: 10,
  TRIVIAL: 5,
};
```

- You are free to tweak these variables to your needs.
- `PROTOCOL_VERSION`: This string defines the SHARP protocol version the server adheres to. Clients and servers with mismatching `PROTOCOL_VERSION` values will typically reject connections to ensure compatibility.
- `KEYWORDS`: This object contains sets of keywords used to automatically classify incoming emails into categories like 'promotions', 'social', etc. Modifying these sets will change how emails are categorized. The classification also considers HTML structure for promotions. If no keywords match and HTML structure doesn't strongly indicate a promotion, emails default to 'primary'.
- `HASHCASH_THRESHOLDS`: These values define the number of leading zero bits required in a SHA-1 hash of a Hashcash stamp for an email to be processed:
  - `GOOD` (e.g., 18 bits): The email has sufficient proof-of-work and is processed normally (status: 'pending' or 'scheduled').
  - `WEAK` (e.g., 10 bits): The email has some proof-of-work but less than `GOOD`. It's accepted but marked as 'spam'.
  - `TRIVIAL` (e.g., 5 bits): The email has minimal proof-of-work. It's accepted but marked as 'spam'. If the proof-of-work is below `TRIVIAL`, the `/api/send` endpoint will reject the request with a 429 status, asking for at least `TRIVIAL` bits.
  - The SHARP TCP server itself does not directly validate Hashcash upon connection; this is handled by the HTTP `/api/send` endpoint before an email is queued for local or remote delivery.

Additionally, `main.js` includes IQ-based vocabulary checks:

```javascript
// filepath: c:\Users\FaceDev\Documents\GitHub\twoblade\SHARP\main.js
function checkVocabulary(text, iq) {
  let maxWordLength;

  if (iq < 90) maxWordLength = 3;
  else if (iq < 100) maxWordLength = 4;
  // ... and so on
  else return { isValid: true, limit: null }; // No limit for IQ >= 140

  // ... logic to check word lengths ...
}
```

- `checkVocabulary`: This function, used by both the SHARP TCP server (for `EMAIL_CONTENT`) and the `/api/send` endpoint, limits the maximum word length in plain text email bodies based on the sender's IQ (fetched from the `users` table). **This behavior is optional and can be totally removed if needed.**
