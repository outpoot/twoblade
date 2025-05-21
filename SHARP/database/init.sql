DROP TABLE IF EXISTS emails;

DROP TABLE IF EXISTS user_secret_codes;

DROP TABLE IF EXISTS users;

DROP TYPE IF EXISTS email_status;

DROP TYPE IF EXISTS email_classification;

CREATE TYPE email_status AS ENUM (
    'pending', -- Initial state
    'sending', -- Transmission in progress
    'sent', -- Successfully delivered
    'failed', -- Transmission failed
    'rejected', -- Explicitly rejected by remote server
    'scheduled', -- Scheduled for future delivery
    'spam' -- Marked as spam by the system
);

CREATE TYPE email_classification AS ENUM (
    'primary',
    'promotions',
    'social',
    'forums',
    'updates'
);

CREATE TABLE
    users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) NOT NULL UNIQUE,
        domain VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        iq INTEGER,
        is_banned BOOLEAN DEFAULT FALSE,
        is_admin BOOLEAN DEFAULT FALSE,
        ip VARCHAR(48),
        user_agent TEXT,
        deleted_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

CREATE INDEX idx_users_username ON users (username);
CREATE INDEX idx_users_ip ON users(ip);

CREATE TABLE
    user_secret_codes (
        code VARCHAR(64) PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at TIMESTAMP
        WITH
            TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
            ip VARCHAR(48),
            user_agent TEXT
    );

CREATE INDEX idx_user_secret_codes_user_id ON user_secret_codes (user_id);

CREATE TABLE
    emails (
        id SERIAL PRIMARY KEY,
        from_address VARCHAR(255) NOT NULL, -- format: user@domain
        from_domain VARCHAR(255) NOT NULL, -- extracted domain
        to_address VARCHAR(255) NOT NULL, -- format: user@domain
        to_domain VARCHAR(255) NOT NULL, -- extracted domain
        subject TEXT,
        body TEXT,
        content_type VARCHAR(50) DEFAULT 'text/plain',
        html_body TEXT,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        error_message TEXT DEFAULT NULL,
        status email_status DEFAULT 'pending',
        snooze_until TIMESTAMP
        WITH
            TIME ZONE DEFAULT NULL,
        read_at TIMESTAMP
        WITH
            TIME ZONE DEFAULT NULL,
        scheduled_at TIMESTAMP
        WITH
            TIME ZONE DEFAULT NULL,
        classification email_classification DEFAULT 'primary',
        reply_to_id INTEGER REFERENCES emails(id),
        thread_id INTEGER REFERENCES emails(id),
        expires_at TIMESTAMP WITH TIME ZONE DEFAULT NULL,
        self_destruct BOOLEAN DEFAULT FALSE
    );

CREATE INDEX idx_emails_from ON emails (from_address);

CREATE INDEX idx_emails_to ON emails (to_address);

CREATE INDEX idx_emails_status ON emails (status);

CREATE INDEX idx_emails_thread_id ON emails(thread_id);

CREATE TABLE
    email_stars (
        email_id INTEGER REFERENCES emails (id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        starred_at TIMESTAMP
        WITH
            TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (email_id, user_id)
    );

CREATE INDEX idx_email_stars_user ON email_stars (user_id);

CREATE TABLE
    email_drafts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        to_address VARCHAR(255),
        subject TEXT,
        body TEXT,
        content_type VARCHAR(50) DEFAULT 'text/plain',
        html_body TEXT,
        created_at TIMESTAMP
        WITH
            TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP
        WITH
            TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

CREATE INDEX idx_email_drafts_user ON email_drafts (user_id);

CREATE TABLE contacts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    email_address VARCHAR(255) NOT NULL,
    tag VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, email_address) -- Changed unique constraint
);

CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_contacts_email_address ON contacts(email_address);

CREATE TABLE attachments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    key TEXT NOT NULL UNIQUE,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size <= 26214400),
    type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NULL,
    email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX idx_attachments_user_id ON attachments(user_id);
CREATE INDEX idx_attachments_expires ON attachments(expires_at);
CREATE INDEX idx_attachments_email ON attachments(email_id);

CREATE TABLE user_storage_limits (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    storage_limit BIGINT NOT NULL DEFAULT 1073741824, -- 1GB in bytes
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION calculate_user_storage(p_user_id INTEGER) 
RETURNS BIGINT AS $$
BEGIN
    RETURN COALESCE((
        SELECT SUM(a.size)
        FROM attachments a
        LEFT JOIN emails e ON a.email_id = e.id
        WHERE (a.user_id = p_user_id OR 
               (e.id IS NOT NULL AND 
                EXISTS (SELECT 1 FROM users u 
                        WHERE u.id = p_user_id AND 
                              (e.from_address = CONCAT(u.username, '#', u.domain) OR 
                               e.to_address = CONCAT(u.username, '#', u.domain))
                       )
               )
              )
        AND a.status != 'failed'
    ), 0);
END;
$$ LANGUAGE plpgsql;

CREATE TABLE user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    notifications_enabled BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS used_hashcash_tokens (
   token TEXT PRIMARY KEY,
   expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_used_hashcash_tokens_expires_at ON used_hashcash_tokens(expires_at);

DROP TYPE IF EXISTS migration_status;

CREATE TYPE migration_status AS ENUM (
    'scheduled', -- Initial state
    'running', -- Migration in progress
    'failed', -- Migration failed
    'migrated' -- Successfully migrated
);

CREATE TABLE IF NOT EXISTS migrations (
   id TEXT PRIMARY KEY,
   status migration_status DEFAULT 'scheduled',
   modfied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
