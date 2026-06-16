# 项目简介

使用自然语言指令，让 agent 自动化在浏览器上完成任务。

# 环境配置

在 `src` 目录创建文件 `.env`，填写以下内容：

```shell
OPENAI_BASE_URL=""
OPENAI_API_KEY=""
```

安装第三方库：

```shell
cd src
npm install # or bun install
npx playwright install chromium # 安装浏览器内核
```

# 运行

```shell
cd src
npx tsx agent.ts
```