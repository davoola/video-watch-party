// 用法: npm run create-user
// 会交互式询问用户名和密码，写入 SQLite 用户表
// 库中第一个用户自动成为管理员。

const path = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { createUser, listUsers, DATABASE_PATH } = (() => {
  const users = require('../src/users');
  const { DATABASE_PATH } = require('../src/config');
  // 触发 db 初始化 / 迁移
  require('../src/db').getDb();
  return { ...users, DATABASE_PATH };
})();

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
        if (char === '\u0003') process.exit(1);
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

  const displayName = (await ask(rl, '显示名（直接回车则与用户名相同）: ')).trim() || username;

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

  const existing = listUsers().find((u) => u.username === username);
  if (existing) {
    const { updateUser } = require('../src/users');
    await updateUser(username, { password, displayName }, { allowRoleChange: false });
    console.log(`\n已更新用户: ${username}`);
  } else {
    const user = await createUser({ username, password, displayName });
    console.log(`\n已创建用户: ${username}（角色: ${user.role === 'admin' ? '管理员' : '普通用户'}）`);
  }
  console.log(`数据库: ${DATABASE_PATH}\n`);
  rl.close();
}

main().catch((err) => {
  console.error('创建用户失败:', err.message || err);
  process.exit(1);
});
