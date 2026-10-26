// 用法: npm run create-user
// 会交互式询问用户名和密码，将 bcrypt 哈希后的结果写入 SQLite 用户表
// 不提供任何注册页面/接口，账号只能由管理员通过这个脚本在服务器上创建。

const path = require('path');
const readline = require('readline');
const bcrypt = require('bcryptjs');

// 确保从项目根目录加载 .env（脚本在 scripts/ 下运行）
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { getDb } = require('../src/db');
const { DATABASE_PATH } = require('../src/config');

const SALT_ROUNDS = 12;
const DEFAULT_AVATAR = '/avatar/default.png';

function ask(rl, question, hidden = false) {
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, resolve);
      return;
    }
    const stdin = process.stdin;
    process.stdout.write(question);
    let input = '';
    let done = false;
    const onData = (chunk) => {
      const str = chunk.toString('utf8');
      for (const char of str) {
        if (char === '\n' || char === '\r' || char === '\u0004') {
          if (done) return;
          done = true;
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (char === '\u0003') {
          process.exit(1);
        }
        if (char === '\u007f' || char === '\b') {
          input = input.slice(0, -1);
          continue;
        }
        input += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const username = (await ask(rl, '用户名: ')).trim();
  if (!username) {
    console.error('用户名不能为空');
    rl.close();
    process.exit(1);
  }

  const password = await ask(rl, '密码（输入时不显示）: ', true);
  if (!password || password.length < 8) {
    console.error('密码至少需要 8 位');
    rl.close();
    process.exit(1);
  }

  const confirm = await ask(rl, '再次输入密码确认: ', true);
  if (password !== confirm) {
    console.error('两次输入的密码不一致');
    rl.close();
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const database = getDb();

  const existing = database
    .prepare('SELECT username, avatar FROM users WHERE username = ?')
    .get(username);
  const isUpdate = Boolean(existing);
  const avatar = (existing && existing.avatar) || DEFAULT_AVATAR;

  database
    .prepare(
      `INSERT INTO users (username, hash, avatar) VALUES (?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         hash = excluded.hash,
         avatar = COALESCE(users.avatar, excluded.avatar)`
    )
    .run(username, hash, avatar);

  console.log(`\n${isUpdate ? '已更新' : '已创建'}用户: ${username}`);
  console.log(`用户信息已保存到 SQLite: ${DATABASE_PATH}\n`);

  rl.close();
}

main().catch((err) => {
  console.error('创建用户失败:', err);
  process.exit(1);
});
