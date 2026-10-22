import { defineConfig } from "vitest/config";

// 测试会启动真实子进程(git / node / shell)并操作临时目录,并行跑时会互相抢 CPU 与磁盘,
// 表现为随机超时。改为按文件串行执行;总时长仍在 1 分钟内。
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
