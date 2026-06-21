# Return-Browser

## 项目简介

使用自然语言指令，让 agent 自动化在浏览器上完成任务。

## 方向

Agentic AI 原生开发

## 技术栈

- AI IDE: VSCode + Claude Code
- LLM: DeepSeek API
- 开发语言: TypeScript

## 目录结构

```shell
agents.ts # Agent 主程序
package.json # 第三方依赖库
tsconfig.json # TypeScript 编译配置
```

## 环境搭建

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

## 项目状态

- [x] Proposal
- [x] MVP
- [x] Final