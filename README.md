<img style="width: 128px; height: 128px" src="website/static/logo.svg" /><h1 style="font-size: 48px"><a href="https://twoblade.com">Twoblade.com</a> - an email protocol & client</h1>
[Privacy Policy](https://twoblade.com/legal/privacy) | [Terms of Service](https://twoblade.com/legal/terms) | [License](LICENSE) | [YouTube video](https://twoblade.com)

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
    npm install
    ```

3.  **Run the initialization script:**
    ```bash
    bash init.sh
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
    npm run dev
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
    *   Add the following variables, replacing the values with your actual configuration:

        ```
        PUBLIC_DOMAIN=yourdomain.com
        ```

        **Additional variables:** You may also need to configure the following variables in your `.env` file:

        ```
        DATABASE_URL=postgres://<your-database>
        PUBLIC_DOMAIN=yourdomain.com
        PUBLIC_WEBSOCKET_URL=https://localhost:3001

        JWT_SECRET=

        PRIVATE_B2_KEY_ID=
        PRIVATE_B2_APP_KEY=
        PRIVATE_B2_BUCKET=
        PRIVATE_B2_REGION=
        PRIVATE_B2_ENDPOINT=https://s3.<region>.backblazeb2.com

        TEST_AUTH_TOKEN=<a-cookie-from-the-website-OPTIONAL-used-for-/test>

        REDIS_URL=
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

## Database Initialization

1.  **Configure the `docker-compose.yml` file:**

    *   Navigate to the `SHARP/database` directory.
    *   Edit the `docker-compose.yml` file to set the `POSTGRES_PASSWORD` environment variable.  It is currently set to `REPLACE_ME`.

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

2.  **Start the database:**
    ```bash
    docker compose up -d
    ```

3.  **Initialize the database schema:**
    ```bash
    docker exec -i postgres-db psql -U postgres < init.sql
    ```

# Other SHARP instances
* ⭐ https://twoblade.com - the official client for SHARP.
* https://garymail.org
