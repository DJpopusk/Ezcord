const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/ezcord';
const poolConfig = { connectionString };

if (process.env.PG_SSL === 'true') {
    poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);

async function initializeDatabase() {
    const statements = [
        `CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            avatar TEXT,
            status TEXT DEFAULT 'Online',
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS servers (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT,
            owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS channels (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(name, server_id)
        )`,
        `CREATE TABLE IF NOT EXISTS messages (
            id SERIAL PRIMARY KEY,
            content TEXT NOT NULL,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS direct_messages (
            id SERIAL PRIMARY KEY,
            content TEXT NOT NULL,
            sender_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS file_uploads (
            id SERIAL PRIMARY KEY,
            filename TEXT NOT NULL,
            filepath TEXT NOT NULL,
            filetype TEXT,
            filesize INTEGER,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS reactions (
            id SERIAL PRIMARY KEY,
            emoji TEXT NOT NULL,
            message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(message_id, user_id, emoji)
        )`,
        `CREATE TABLE IF NOT EXISTS server_members (
            id SERIAL PRIMARY KEY,
            server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            joined_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(server_id, user_id)
        )`,
        `CREATE TABLE IF NOT EXISTS friends (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            friend_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE(user_id, friend_id)
        )`
    ];

    for (const statement of statements) {
        await pool.query(statement);
    }

    await ensureDefaultChannels();

    console.log('PostgreSQL database ready');
}

async function ensureDefaultChannels() {
    const defaultServerName = 'Home Base';
    let serverId;
    const existing = await pool.query('SELECT id FROM servers WHERE name = $1 LIMIT 1', [defaultServerName]);
    if (existing.rows.length) {
        serverId = existing.rows[0].id;
    } else {
        const inserted = await pool.query(
            `INSERT INTO servers (name, icon)
             VALUES ($1, $2) RETURNING id`,
            [defaultServerName, defaultServerName.charAt(0).toUpperCase()]
        );
        serverId = inserted.rows[0].id;
    }

    const defaultChannels = [
        { name: 'general', type: 'text' },
        { name: 'random', type: 'text' }
    ];

    for (const channel of defaultChannels) {
        await pool.query(
            `INSERT INTO channels (name, type, server_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (name, server_id) DO NOTHING`,
            [channel.name, channel.type, serverId]
        );
    }
}

const userDB = {
    async create(username, email, hashedPassword) {
        const avatar = username.charAt(0).toUpperCase();
        const { rows } = await pool.query(
            `INSERT INTO users (username, email, password, avatar)
             VALUES ($1, $2, $3, $4)
             RETURNING id, username, email, avatar, status`,
            [username, email, hashedPassword, avatar]
        );
        return rows[0];
    },

    async findByEmail(email) {
        const { rows } = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        return rows[0];
    },

    async findById(id) {
        const { rows } = await pool.query(
            'SELECT id, username, email, avatar, status FROM users WHERE id = $1',
            [id]
        );
        return rows[0];
    },

    async updateStatus(id, status) {
        await pool.query('UPDATE users SET status = $1 WHERE id = $2', [status, id]);
    },

    async getAll() {
        const { rows } = await pool.query('SELECT id, username, email, avatar, status FROM users');
        return rows;
    },

    async updateAvatar(id, avatarPath) {
        await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatarPath, id]);
    }
};

const messageDB = {
    async create(content, userId, channelId) {
        const { rows } = await pool.query(
            `INSERT INTO messages (content, user_id, channel_id)
             VALUES ($1, $2, $3) RETURNING id, content, user_id AS "userId", channel_id AS "channelId"`,
            [content, userId, channelId]
        );
        return rows[0];
    },

    async getByChannel(channelId, limit = 50) {
        const { rows } = await pool.query(
            `SELECT m.id, m.content, m.created_at, u.username, u.avatar
             FROM messages m
             JOIN users u ON m.user_id = u.id
             WHERE m.channel_id = $1
             ORDER BY m.created_at DESC
             LIMIT $2`,
            [channelId, limit]
        );
        return rows.reverse();
    }
};

const dmDB = {
    async create(content, senderId, receiverId) {
        const { rows } = await pool.query(
            `INSERT INTO direct_messages (content, sender_id, receiver_id)
             VALUES ($1, $2, $3)
             RETURNING id, content, sender_id AS "senderId", receiver_id AS "receiverId"`,
            [content, senderId, receiverId]
        );
        return rows[0];
    },

    async getConversation(userId1, userId2, limit = 50) {
        const { rows } = await pool.query(
            `SELECT dm.id, dm.content, dm.created_at, dm.sender_id, dm.receiver_id,
                    u.username, u.avatar
             FROM direct_messages dm
             JOIN users u ON dm.sender_id = u.id
             WHERE (dm.sender_id = $1 AND dm.receiver_id = $2)
                OR (dm.sender_id = $2 AND dm.receiver_id = $1)
             ORDER BY dm.created_at DESC
             LIMIT $3`,
            [userId1, userId2, limit]
        );
        return rows.reverse();
    },

    async markAsRead(messageId) {
        await pool.query('UPDATE direct_messages SET read = TRUE WHERE id = $1', [messageId]);
    }
};

const fileDB = {
    async create(filename, filepath, filetype, filesize, userId, channelId) {
        const { rows } = await pool.query(
            `INSERT INTO file_uploads (filename, filepath, filetype, filesize, user_id, channel_id)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, filename, filepath`,
            [filename, filepath, filetype, filesize, userId, channelId]
        );
        return rows[0];
    },

    async getByChannel(channelId) {
        const { rows } = await pool.query(
            `SELECT f.*, u.username
             FROM file_uploads f
             JOIN users u ON f.user_id = u.id
             WHERE f.channel_id = $1
             ORDER BY f.created_at DESC`,
            [channelId]
        );
        return rows;
    }
};

const reactionDB = {
    async add(emoji, messageId, userId) {
        await pool.query(
            `INSERT INTO reactions (emoji, message_id, user_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
            [emoji, messageId, userId]
        );
    },

    async remove(emoji, messageId, userId) {
        await pool.query(
            'DELETE FROM reactions WHERE emoji = $1 AND message_id = $2 AND user_id = $3',
            [emoji, messageId, userId]
        );
    },

    async getByMessage(messageId) {
        const { rows } = await pool.query(
            `SELECT r.emoji, COUNT(*) AS count, STRING_AGG(u.username, ',') AS users
             FROM reactions r
             JOIN users u ON r.user_id = u.id
             WHERE r.message_id = $1
             GROUP BY r.emoji`,
            [messageId]
        );
        return rows;
    }
};

const friendDB = {
    async sendRequest(userId, friendId) {
        const { rowCount } = await pool.query(
            `INSERT INTO friends (user_id, friend_id, status)
             VALUES ($1, $2, 'pending')
             ON CONFLICT (user_id, friend_id) DO NOTHING`,
            [userId, friendId]
        );
        return { changes: rowCount };
    },

    async acceptRequest(userId, friendId) {
        await pool.query(
            'UPDATE friends SET status = $1 WHERE user_id = $2 AND friend_id = $3',
            ['accepted', friendId, userId]
        );
        await pool.query(
            `INSERT INTO friends (user_id, friend_id, status)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, friend_id) DO UPDATE SET status = EXCLUDED.status`,
            [userId, friendId, 'accepted']
        );
    },

    async rejectRequest(userId, friendId) {
        await pool.query(
            'DELETE FROM friends WHERE user_id = $1 AND friend_id = $2',
            [friendId, userId]
        );
    },

    async removeFriend(userId, friendId) {
        await pool.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [userId, friendId]);
        await pool.query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [friendId, userId]);
    },

    async getFriends(userId) {
        const { rows } = await pool.query(
            `SELECT u.id, u.username, u.email, u.avatar, u.status, f.status AS friendship_status
             FROM friends f
             JOIN users u ON f.friend_id = u.id
             WHERE f.user_id = $1 AND f.status = 'accepted'`,
            [userId]
        );
        return rows;
    },

    async getPendingRequests(userId) {
        const { rows } = await pool.query(
            `SELECT u.id, u.username, u.email, u.avatar, u.status
             FROM friends f
             JOIN users u ON f.user_id = u.id
             WHERE f.friend_id = $1 AND f.status = 'pending'`,
            [userId]
        );
        return rows;
    },

    async checkFriendship(userId, friendId) {
        const { rows } = await pool.query(
            'SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2 AND status = $3',
            [userId, friendId, 'accepted']
        );
        return rows.length > 0;
    }
};

const serverDB = {
    async create(name, ownerId) {
        const icon = name.charAt(0).toUpperCase();
        const { rows } = await pool.query(
            `INSERT INTO servers (name, icon, owner_id)
             VALUES ($1, $2, $3)
             RETURNING id, name, icon, owner_id AS "ownerId"`,
            [name, icon, ownerId]
        );
        return rows[0];
    },

    async getUserServers(userId) {
        const { rows } = await pool.query(
            `SELECT s.* FROM servers s
             JOIN server_members sm ON s.id = sm.server_id
             WHERE sm.user_id = $1
             ORDER BY s.created_at ASC`,
            [userId]
        );
        return rows;
    },

    async addMember(serverId, userId) {
        await pool.query(
            `INSERT INTO server_members (server_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (server_id, user_id) DO NOTHING`,
            [serverId, userId]
        );
    },

    async getMembers(serverId) {
        const { rows } = await pool.query(
            `SELECT u.id, u.username, u.avatar, u.status
             FROM users u
             JOIN server_members sm ON u.id = sm.user_id
             WHERE sm.server_id = $1`,
            [serverId]
        );
        return rows;
    }
};

module.exports = {
    pool,
    initializeDatabase,
    userDB,
    messageDB,
    dmDB,
    fileDB,
    reactionDB,
    friendDB,
    serverDB
};
