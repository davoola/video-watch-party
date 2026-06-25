// 可选工具：把视频文件的 "moov atom"（索引信息）挪到文件开头，让浏览器不用等下载完
// 整个文件（或来回跳着读取）才能开始播放——这通常是网页视频"明明带宽够却感觉很慢"的
// 头号原因，尤其是手机直接录制、或某些录屏/转码工具导出的 mp4 文件。
//
// 用法:
//   node scripts/optimizeVideo.js <视频文件路径> [<另一个文件路径> ...]
//
// 这是无损操作（只重新排列容器结构，不重新编码画面/声音），速度很快
// （通常几秒到几十秒，和文件大小、磁盘速度有关，和视频时长基本无关）。
//
// 为了不动你的原始文件，会输出为同目录下的 <原文件名>.faststart.mp4，
// 确认没问题后，你可以自己手动替换原文件。

const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

function checkFfmpeg() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version']);
    proc.on('error', () => resolve(false));
    proc.on('exit', (code) => resolve(code === 0));
  });
}

function optimizeOne(inputPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(inputPath)) {
      return reject(new Error('文件不存在: ' + inputPath));
    }

    const dir = path.dirname(inputPath);
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    const outputPath = path.join(dir, `${base}.faststart${ext}`);

    console.log(`处理中: ${inputPath}`);
    console.log(`  输出到: ${outputPath}`);

    const args = [
      '-y',
      '-i', inputPath,
      '-c', 'copy', // 只重新封装容器结构，不重新编码（无损、快）
      '-movflags', '+faststart',
      outputPath,
    ];

    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) {
        const beforeSize = fs.statSync(inputPath).size;
        const afterSize = fs.statSync(outputPath).size;
        console.log(`  完成 ✓ (${(beforeSize / 1024 / 1024).toFixed(1)}MB -> ${(afterSize / 1024 / 1024).toFixed(1)}MB)`);
        resolve(outputPath);
      } else {
        reject(new Error(`ffmpeg 处理失败 (退出码 ${code}):\n${stderr.slice(-500)}`));
      }
    });
  });
}

async function main() {
  const files = process.argv.slice(2);

  if (files.length === 0) {
    console.log('用法: node scripts/optimizeVideo.js <视频文件路径> [<另一个文件路径> ...]');
    process.exit(1);
  }

  const hasFfmpeg = await checkFfmpeg();
  if (!hasFfmpeg) {
    console.error('未检测到 ffmpeg，请先安装（如: apt install ffmpeg），再运行此脚本。');
    process.exit(1);
  }

  let okCount = 0;
  for (const file of files) {
    try {
      await optimizeOne(path.resolve(file));
      okCount++;
    } catch (err) {
      console.error(`  失败: ${err.message}`);
    }
  }

  console.log(`\n完成 ${okCount}/${files.length} 个文件。`);
  console.log('请自行确认输出文件播放正常后，再决定是否替换原文件。');
}

main();
