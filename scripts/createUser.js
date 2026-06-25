// 用法: npm run create-user
// 会交互式询问用户名和密码，将 bcrypt 哈希后的结果写入 config/users.json
// 不提供任何注册页面/接口，账号只能由管理员通过这个脚本在服务器上创建。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const bcrypt = require('bcryptjs');

const USERS_FILE = path.join(__dirname, '..', 'config', 'users.json');
const SALT_ROUNDS = 12;

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + '\n', 'utf-8');
}

function ask(rl, question, hidden = false) {
  return new Promise((resolve) => {
    if (!hidden) {
      rl.question(question, resolve);
      return;
    }
    // 隐藏密码输入
    const stdin = process.stdin;
    process.stdout.write(question);
    let input = '';
    const onData = (char) => {
      char = char.toString('utf8');
      if (char === '\n' || char === '\r' || char === '\u0004') {
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
      if (char === '\u007f') {
        input = input.slice(0, -1);
        return;
      }
      input += char;
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
  const users = loadUsers();
  const isUpdate = Boolean(users[username]);
  users[username] = hash;
  saveUsers(users);

  console.log(`\n${isUpdate ? '已更新' : '已创建'}用户: ${username}`);
  console.log(`用户信息已保存到: ${USERS_FILE}\n`);

  rl.close();
}

main();
