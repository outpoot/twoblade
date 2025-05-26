<img style="width: 128px; height: 128px" src="website/static/logo.svg" /><h1 style="font-size: 48px"><a href="https://twoblade.com">Twoblade.com</a> - an email protocol & client</h1>
[Privacy Policy](https://twoblade.com/legal/privacy) | [Terms of Service](https://twoblade.com/legal/terms) | [License](LICENSE) | [YouTube video](https://youtu.be/nALc9GwZdFc)

**Twoblade.com** is an interface for **SHARP** (**S**elf-**H**osted **A**ddress **R**outing **P**rotocol) - a decentralized email system that uses the `#` symbol for addressing (e.g., `user#domain.com`).

## SHARP

*   SHARP uses addresses in the format `user#domain.com`.
*   `user` is the username of the recipient.
*   `domain.com` is the domain name of the SHARP server.

SHARP's HTML allows for reactive styling:
```html
<!-- Theme-aware styling -->
<div style="background: {$LIGHT ? '#ffffff' : '#1a1a1a'}">
<p style="color: {$DARK ? '#ffffff' : '#000000'}">Content</p>

<!-- Complex conditional styling -->
<div style="
  background: {$DARK ? '#2d2d2d' : '#f0f0f0'};
  border: {$DARK ? '1px solid #404040' : '1px solid #ddd'};
  box-shadow: {$DARK ? '0 2px 4px rgba(0,0,0,0.5)' : '0 2px 4px rgba(0,0,0,0.1)'};
">

<!-- Available operators: $DARK, $LIGHT -->
```

## Running the SHARP Server

1.  **Navigate to the `SHARP` directory:**
    ```bash
    cd SHARP
    ```

2.  **Install dependencies:**
    ```bash
    bun install
    ```

3.  **Run the initialization script:**
    ```bash
    bash database/init.sh
    ```

4.  **Set up environment variables:**

    *   The `init.sh` script will create a `.env` file in the `SHARP` directory.
    *   It will prompt you for your domain name and set up the basic `.env` file.
    *   You may need to modify the `.env` file to match your actual configuration, especially the `DATABASE_URL`.
        ```
        DATABASE_URL=postgres://user:password@host:port/database
        SHARP_PORT=5000
        HTTP_PORT=5001
        DOMAIN_NAME=yourdomain.com
        ```

5.  **Run the server:**
    ```bash
    cd ..
    bun run .
    ```

6.  **Add SRV records to Cloudflare (or your DNS provider):**

    *   After setting up the SHARP server, you need to add SRV records to your domain's DNS settings so that other SHARP users can discover your server.
    *   These records should point to your server's address and port.  The specific records depend on your configuration, but here's an example:

        ```
        _sharp._tcp.yourdomain.com. 86400 IN SRV 10 0 5000 yourdomain.com.
        ```

    *   Replace `yourdomain.com` with your actual domain name and `5000` with the port your SHARP server is running on (defined by `SHARP_PORT` in your `.env` file).
    *   Consult your DNS provider's documentation for specific instructions on adding SRV records.  For Cloudflare, you can typically add these records in the DNS settings panel.

## Running the Website

1.  **Navigate to the `website` directory:**
    ```bash
    cd website
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up environment variables:**

    *   Create a `.env` file in the `website` directory.
    *   Add the following variable, replacing the values with your actual configuration:
        ```
        PUBLIC_DOMAIN=yourdomain.com
        ```

        **Additional variables:** You may also need to configure the following variables in your `.env` file:
        ```python
        # Database from docker-compose
        DATABASE_URL=postgres://postgres:REPLACE_ME@localhost:5432/twoblade
        PUBLIC_DOMAIN=yourdomain.com
        PUBLIC_WEBSOCKET_URL=https://localhost:3001

        # The JWT secret should be long, random and similar to a password. Do not share it with anyone.
        # Run `openssl rand -hex 64` to generate one
        JWT_SECRET=

        # The amount of connections a singular IP can have to the websocket server.
        # Reducing this from the default may somewhat alleviate spam.
        # It is not necessary to define this, as the default is inferred as 5
        IP_CONN_LIMIT=5

        # S3-compatible works too.
        PRIVATE_B2_KEY_ID=
        PRIVATE_B2_APP_KEY=
        PRIVATE_B2_BUCKET=
        PRIVATE_B2_REGION=
        PRIVATE_B2_ENDPOINT=https://s3.<region>.backblazeb2.com

        # A cookie from the website, optional & used in /test
        TEST_AUTH_TOKEN=

        # Comes from docker-compose
        REDIS_URL=redis://redis:6379

        # Cloudflare Turnstile keys, these are for testing & will validate any req. Replace with actual ones in prod.
        PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
        ```

        Ensure that these URLs match the actual URLs of your API server, SHARP server, and WebSocket server.
        

4.  **Run the development server:**
    ```bash
    npm run dev -- --open
    ```

## Attachments Setup
You will need a [Backblaze](https://www.backblaze.com/) account or any S3-compatible storage provider.

### Using Backblaze B2
```bash
wget https://github.com/Backblaze/B2_Command_Line_Tool/releases/latest/download/b2-linux -O "b2"
chmod +x b2
./b2 account authorize

./b2 bucket update --cors-rules '[
  {
    "corsRuleName": "allowS3PutFromLocalhost",
    "allowedOrigins": ["http://localhost:5173", "REPLACE_ME_WITH_PUBLIC_DOMAIN"],
    "allowedOperations": [
      "s3_put",
      "s3_get"
    ],
    "allowedHeaders": ["*"],
    "exposeHeaders": ["ETag", "x-amz-request-id"],
    "maxAgeSeconds": 3600
  }
]' REPLACE_ME_WITH_BUCKET_NAME
```
- Note to replace `REPLACE_ME_WITH_PUBLIC_DOMAIN` and `REPLACE_ME_WITH_BUCKET_NAME`

### Using other S3-Compatible storage
You can use any S3-compatible storage by setting these environment variables:
```
PRIVATE_B2_KEY_ID=<access-key>
PRIVATE_B2_APP_KEY=<secret-key>
PRIVATE_B2_BUCKET=<bucket-name>
PRIVATE_B2_REGION=<region>
PRIVATE_B2_ENDPOINT=<s3-endpoint>  # Example: https://s3.<region>.amazonaws.com for AWS
```

Make sure to configure CORS rules on your bucket to allow uploads from your domain.

## Running the database

1.  **Change the default database password:** (optional)
    *   Open the `docker-compose.yml` file and change `REPLACE_ME` to something else.
        ```yaml
        version: '3.8'

        services:
          postgres_db:
            # ...
            environment:
              POSTGRES_USER: postgres
              POSTGRES_PASSWORD: REPLACE_ME  # Replace with your desired password
            # ...
        ```
    *   Update your `.env` file with the new password.

2.  **Start the database:**
    ```bash
    docker compose up -d postgres
# Other SHARP instances
* ⭐ https://twoblade.com - the official client for SHARP.
* https://garymail.org
* https://2b.jcjenson.net/
* https://gabserver.me/
