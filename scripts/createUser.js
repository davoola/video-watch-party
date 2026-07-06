// 用法: npm run create-user
// 会交互式询问用户名和密码，将 bcrypt 哈希后的结果写入 config/users.json
// 不提供任何注册页面/接口，账号只能由管理员通过这个脚本在服务器上创建。

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const bcrypt = require('bcryptjs');

const USERS_FILE = path.join(__dirname, '..', 'config', 'users.json');
const SALT_ROUNDS = 12;
const DEFAULT_AVATAR = '/avatar/default.png';

// 内部格式统一为 { hash, avatar }，同时兼容旧的"纯哈希字符串"格式（见 src/users.js 里的说明）
function loadUsers() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
  } catch {
    return {};
  }

  const normalized = {};
  for (const [username, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      normalized[username] = { hash: value, avatar: DEFAULT_AVATAR };
    } else if (value && typeof value === 'object') {
      normalized[username] = { hash: value.hash || '', avatar: value.avatar || DEFAULT_AVATAR };
    }
  }
  return normalized;
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
    let done = false;
    // 注意：不能假设每次 'data' 事件只包含一个字符——正常手动逐键输入时确实通常是这样，
    // 但粘贴密码、或输入被更快地整块送达（比如某些终端/管道场景）时，
    // 一次 'data' 事件可能带来整段多字符的数据（例如 "secret123\n"）。
    // 之前的实现把整个 chunk 当成单个字符和 '\n' 比较，永远不相等，导致回车永远不会被识别，
    // 脚本会卡住无法继续。这里改成逐字符扫描 chunk，正确处理其中的换行/退格/Ctrl+C。
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
  const users = loadUsers();
  const existing = users[username];
  const isUpdate = Boolean(existing);
  // 更新已有账号时保留原有头像；新建账号则使用默认头像 /avatar/default.png
  users[username] = {
    hash,
    avatar: (existing && existing.avatar) || DEFAULT_AVATAR,
  };
  saveUsers(users);

  console.log(`\n${isUpdate ? '已更新' : '已创建'}用户: ${username}`);
  console.log(`用户信息已保存到: ${USERS_FILE}\n`);

  rl.close();
}

main();
