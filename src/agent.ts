import { chromium, Browser, Page } from "playwright";
import OpenAI from "openai";
import env from "dotenv";
import * as readline from "readline";

env.config();

// ---- 验证/拦截检测 ----

/** 常见验证页特征：URL 关键词、页面标题、正文内容 */
const VERIFICATION_SIGNALS = {
  urlKeywords: ["captcha", "verify", "challenge", "login", "auth", "denied", "block", "robot", "human"],
  titleKeywords: ["验证", "captcha", "verify", "登录", "login", "challenge", "安全检查", "人机验证"],
  contentKeywords: ["验证码", "captcha", "verify you are", "are you a robot", "请完成验证", "人机验证", "安全验证", "点击此处验证"],
};

async function detectVerificationPage(page: Page): Promise<boolean> {
  try {
    const url = page.url().toLowerCase();
    const title = (await page.title()).toLowerCase();
    // 只取 body 前 2000 字符检测，避免大页面性能问题
    const bodyText = (await page.textContent("body"))?.slice(0, 2000).toLowerCase() || "";

    const urlHit = VERIFICATION_SIGNALS.urlKeywords.some(k => url.includes(k));
    const titleHit = VERIFICATION_SIGNALS.titleKeywords.some(k => title.includes(k));
    const contentHit = VERIFICATION_SIGNALS.contentKeywords.some(k => bodyText.includes(k));

    return urlHit || titleHit || contentHit;
  } catch {
    return false; // 页面可能还在加载，保守处理
  }
}

// ---- 手动验证等待 ----

function waitForManualVerification(rl?: readline.Interface): Promise<void> {
  const ownRl = !rl; // 是否自己创建的 readline
  const iface = rl || readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    iface.question("\n⚠️ 检测到验证/拦截页面，请在浏览器中手动完成验证后按 Enter 继续...", () => {
      if (ownRl) iface.close(); // 只关闭自己创建的，共享的不关
      console.log("继续执行任务...\n");
      resolve();
    });
  });
}

// ---- 标签页管理 ----

/** 获取当前活动页面（最后创建/操作的标签页），无页面时自动创建新标签页 */
function getActivePage(browser: Browser): Page {
  const pages = browser.contexts()[0].pages();
  if (pages.length === 0) {
    // 所有标签页都关闭了，创建新标签页
    return browser.contexts()[0].newPage();
  }
  return pages[pages.length - 1];
}

/** 列出所有标签页信息 */
function listTabs(browser: Browser): { index: number; url: string; title: string }[] {
  return browser.contexts()[0].pages().map((p, i) => {
    try {
      return { index: i, url: p.url(), title: p.title() };
    } catch {
      return { index: i, url: "(已关闭)", title: "(已关闭)" };
    }
  });
}

// 1. 初始化 OpenAI 客户端
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 2. 定义 LLM 可以调用的工具
const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "click_element",
      description: "点击页面上的元素",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "元素上的文本，例如 'Search', 'Submit'" },
          role: { type: "string", enum: ["button", "link"], description: "元素角色" }
        },
        required: ["name", "role"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "在输入框中输入文本",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "输入框的标签或占位符文本" },
          text: { type: "string", description: "要输入的内容" }
        },
        required: ["label", "text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "scroll_down",
      description: "向下滚动页面",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "check_page",
      description: "获取当前页面的概览信息（标题、URL、页面标题/区域文本），用于判断当前所在页面和任务是否完成",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description: "导航到指定 URL",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要导航到的 URL" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_tabs",
      description: "列出浏览器中所有打开的标签页",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "switch_tab",
      description: "切换到指定标签页（通过序号或标题关键词匹配）",
      parameters: {
        type: "object",
        properties: {
          identifier: { type: "string", description: "标签页序号（从0开始）或标题关键词" }
        },
        required: ["identifier"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "new_tab",
      description: "打开一个新标签页，可选导航到指定 URL",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "可选，要在新标签页中打开的 URL" }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_tab",
      description: "关闭当前标签页",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "finish_task",
      description: "当任务完成时调用此函数，浏览器会保持打开以等待下一个任务",
      parameters: {
        type: "object",
        properties: {
          result: { type: "string", description: "任务的最终结果总结" }
        },
        required: ["result"]
      }
    }
  }
];

// 3. 优化工具执行器：更智能的定位 + 快速失败
async function executeTool(browser: Browser, page: Page, toolName: string, args: any): Promise<string> {
  try {
    switch (toolName) {
      case "click_element": {
        // 多策略定位：精确文本 → 模糊文本 → role → has-text
        const name = args.name;
        const role = args.role as string;
        let clickLocator = page.getByText(name, { exact: true });
        try {
          await clickLocator.click({ timeout: 2000 });
          return `成功点击了: ${name}`;
        } catch {}

        // 策略2: 模糊文本匹配
        clickLocator = page.getByText(name).first();
        try {
          await clickLocator.click({ timeout: 2000 });
          return `成功点击了(模糊): ${name}`;
        } catch {}

        // 策略3: 按 role + name 找
        if (role) {
          try {
            await page.getByRole(role as any, { name }).first().click({ timeout: 2000 });
            return `成功点击了(role): ${name}`;
          } catch {}
        }

        // 策略4: has-text 宽泛查找（link/button/任意可点击元素）
        try {
          await page.locator(`a:has-text("${name}")`).first().click({ timeout: 2000 });
          return `成功点击了(a): ${name}`;
        } catch {}
        try {
          await page.locator(`button:has-text("${name}")`).first().click({ timeout: 2000 });
          return `成功点击了(button): ${name}`;
        } catch {}
        try {
          await page.locator(`:has-text("${name}")`).first().click({ timeout: 2000 });
          return `成功点击了(any): ${name}`;
        } catch {}

        return `操作失败: 找不到元素 "${name}"，请尝试滚动页面或使用 check_page 确认页面内容`;
      }

      case "type_text": {
        // 优先通过 placeholder 查找，其次通过 aria-label 查找
        const typeLocator = page.getByPlaceholder(args.label)
          .or(page.getByLabel(args.label))
          .or(page.getByRole("searchbox", { name: args.label }))
          .first();
        await typeLocator.fill(args.text, { timeout: 3000 });
        await typeLocator.press("Enter", { delay: 100 });
        return `成功在 ${args.label} 中输入了:${args.text} 并按下回车`;
      }

      case "scroll_down":
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
        return "向下滚动了一屏";

      case "check_page": {
        const info = await page.evaluate(() => {
          const headings: string[] = [];
          document.querySelectorAll("h1, h2, h3, h4, .title, [class*='title'], [class*='header']").forEach(el => {
            const t = (el as HTMLElement).innerText?.trim().slice(0, 80);
            if (t) headings.push(t);
          });
          // 获取页面核心文本区域
          const mainText = document.body?.innerText?.slice(0, 800) || "";
          return {
            title: document.title,
            url: window.location.href,
            headings: [...new Set(headings)].slice(0, 15),
            bodyPreview: mainText.replace(/\n{3,}/g, "\n\n"),
          };
        });
        return `页面概览:
  URL: ${info.url}
  标题: ${info.title}
  页面区域:\n${info.headings.map(h => `  - ${h}`).join("\n")}
  正文预览:\n${info.bodyPreview}`;
      }

      case "navigate":
        await page.goto(args.url, { timeout: 15000 });
        await page.waitForTimeout(1000);
        return `成功导航到: ${args.url}`;

      case "list_tabs": {
        const tabs = listTabs(browser);
        if (tabs.length === 0) return "当前没有打开的标签页";
        return tabs.map(t => `[${t.index}] ${t.title}\n   ${t.url}`).join("\n\n");
      }
      case "switch_tab": {
        const pages = browser.contexts()[0].pages();
        const id = args.identifier;
        // 先尝试按序号匹配
        const byIndex = parseInt(id);
        if (!isNaN(byIndex) && byIndex >= 0 && byIndex < pages.length) {
          const switchedPage = pages[byIndex];
          await switchedPage.bringToFront();
          return `已切换到标签页 [${byIndex}]: ${switchedPage.title()}`;
        }
        // 再尝试按标题关键词匹配
        for (const p of pages) {
          try {
            if (p.title().includes(id)) {
              await p.bringToFront();
              return `已切换到标签页: ${p.title()}`;
            }
          } catch {}
        }
        return `未找到匹配的标签页: ${id}`;
      }
      case "new_tab": {
        const newPage = await browser.contexts()[0].newPage();
        if (args.url) {
          await newPage.goto(args.url, { timeout: 15000 });
          await newPage.waitForTimeout(1000);
        }
        return `已打开新标签页: ${newPage.url()}`;
      }
      case "close_tab": {
        const currentPage = getActivePage(browser);
        await currentPage.close();
        const remaining = browser.contexts()[0].pages().length;
        return `已关闭当前标签页，剩余 ${remaining} 个标签页`;
      }

      case "finish_task":
        return `任务完成: ${args.result}`;

      default:
        return "未知工具";
    }
  } catch (error: any) {
    // 将错误信息反馈给 LLM，这是 Agent 自我纠错的关键！
    return `操作失败: ${error.message.split("\n")[0]}`;
  }
}

// 2. 页面状态提取：提取可交互元素 + 导航/文本元素，告诉 LLM 页面结构和可操作项
async function getPageState(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const elements: string[] = [];
    const seen = new Set<string>(); // 去重

    // 选择器覆盖：链接、按钮、输入框、导航项、有文本的块级元素
    const selectors = [
      "a", "button", "input", "textarea", "select",
      "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']",
      "[onclick]", "[href]",
      "nav a", "nav span", "nav li",
      "li a", "li span", "li button",
      "h1", "h2", "h3", "h4",
    ];

    selectors.forEach(selector => {
      try {
        document.querySelectorAll(selector).forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return;
          // 跳过视口外的元素（离视口太远的不报）
          if (rect.bottom < -200 || rect.top > window.innerHeight + 200) return;

          const htmlEl = el as HTMLElement;
          const tag = htmlEl.tagName.toLowerCase();
          const text = htmlEl.innerText?.trim().slice(0, 50) || "";
          const placeholder = htmlEl.getAttribute("placeholder") || "";
          const ariaLabel = htmlEl.getAttribute("aria-label") || "";
          const href = htmlEl.getAttribute("href")?.slice(0, 60) || "";
          const role = htmlEl.getAttribute("role") || "";
          const className = htmlEl.className?.toString().slice(0, 40) || "";

          // 组合去重 key（文本+标签+位置）
          const key = `${tag}|${text}|${Math.round(rect.x)}|${Math.round(rect.y)}`;
          if (seen.has(key)) return;
          seen.add(key);

          let desc = `<${tag}`;
          if (text) desc += ` text="${text}"`;
          if (placeholder) desc += ` placeholder="${placeholder}"`;
          if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
          if (href) desc += ` href="${href}"`;
          if (role) desc += ` role="${role}"`;
          if (className && (className.includes("nav") || className.includes("menu") || className.includes("tab") || className.includes("btn"))) {
            desc += ` class="${className}"`;
          }
          desc += `>`;

          elements.push(desc);
        });
      } catch {}
    });

    return elements.slice(0, 150).join("\n"); // 限制最多 150 个元素，避免 token 爆炸
  });
}

// 5. Agent 主循环（单次任务，不管理浏览器生命周期，动态获取活动页面）
async function runAgent(browser: Browser, task: string, startUrl?: string, rl?: readline.Interface): Promise<string> {
  // 如果指定了起始 URL，在活动页面上导航
  let page = getActivePage(browser);
  if (startUrl) {
    console.log(`导航到: ${startUrl}`);
    await page.goto(startUrl, { timeout: 15000 });
    await page.waitForTimeout(1000);
  }

  // 初始页面也可能被拦截
  page = getActivePage(browser);
  if (await detectVerificationPage(page)) {
    await waitForManualVerification(rl);
    await page.waitForTimeout(1000);
  }

  page = getActivePage(browser);
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `你是一个浏览器操作助手。你的目标是高效完成用户给定的任务。完成任务后调用 finish_task 汇报结果，浏览器会保持打开以等待下一个任务。

## 核心工作流程
1. 收到任务 → 分析需要做什么 → 执行操作 → 验证结果 → 调用 finish_task
2. 每完成一个步骤后，问自己："任务目标是否已达成？" 如果是，立即 finish_task

## 任务完成判断（重要！）
- 涉及登录的任务：手动验证通过后，用 check_page 检查页面 URL/标题是否已变为登录后的首页。如果是，任务完成。
- 通用规则：当前页面状态是否满足用户任务的全部要求？不够就继续操作，够了就 finish_task。
- 不确定时用 check_page 确认当前页面状态再决定。

## 元素定位
- 优先从页面可交互元素列表中找目标文本，找到后直接 click_element
- 如果列表中找不到目标文本（可能不在视口内），先 scroll_down 再查看新列表
- 如果多次找不到，用 check_page 查看页面整体内容，确认元素是否存在
- 如果操作失败，尝试不同的定位方式（按钮/链接/通用文本），不要放弃

## 操作规则
- 没有迭代次数限制，持续操作直到任务完成，不要因为步骤多而提前放弃
- 操作失败时尝试其他方法（换个定位策略、先滚动、用 check_page 确认页面状态）
- 不要连续重复完全相同的操作，如果一种方式失败 2 次就换思路
- 新网站用 navigate；新标签页用 new_tab
- 链接在新标签页打开时，用 list_tabs 检查并用 switch_tab 切换
- 系统会自动检测 3 次连续失败或 3 次重复操作为死循环并终止，你只需专注于推进任务`
    },
    {
      role: "user",
      content: `任务: ${task}\n\n当前 URL: ${page.url()}\n当前页面可交互元素:\n${await getPageState(page)}`
    }
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 200; // 安全网，防止真正死循环（正常任务不应触发）
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  // 记录最近操作（工具名+参数），用于检测重复操作
  const recentOps: string[] = [];
  const MAX_IDENTICAL_OPS = 3;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`\n--- 循环 ${iterations} ---`);

    // 每次循环前动态获取当前活动页面（可能已切换标签页）
    page = getActivePage(browser);

    // 调用 LLM
    const response = await openai.chat.completions.create({
      model: "deepseek-v4-flash",
      messages,
      tools,
      tool_choice: "auto"
    });

    const choice = response.choices[0];
    messages.push(choice.message);

    // 如果 LLM 停止调用工具，说明任务结束
    if (choice.finish_reason === "stop") {
      console.log("Agent 主动结束:", choice.message.content);
      return choice.message.content || "Agent 未提供结果";
    }

    // 处理 LLM 的工具调用
    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        const toolName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        console.log(`执行工具: ${toolName}`, args);

        // 每次操作前刷新活动页面引用
        page = getActivePage(browser);

        // 1. 执行 Playwright 操作
        const result = await executeTool(browser, page, toolName, args);
        console.log(`执行结果: ${result}`);

        // 2. 追踪连续失败和重复操作
        const isFailure = result.startsWith("操作失败");
        if (isFailure) {
          consecutiveFailures++;
          console.log(`  ⚠️ 连续失败 ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}`);
        } else {
          consecutiveFailures = 0; // 成功则重置失败计数
        }

        // 记录操作签名（工具名+参数），检测重复操作
        const opSig = `${toolName}:${JSON.stringify(args)}`;
        recentOps.push(opSig);
        if (recentOps.length > MAX_IDENTICAL_OPS) recentOps.shift();
        const allSame = recentOps.length >= MAX_IDENTICAL_OPS && recentOps.every(op => op === opSig);
        if (allSame) {
          console.log(`  ⚠️ 连续 ${MAX_IDENTICAL_OPS} 次相同操作，可能陷入循环`);
        }

        // 3. 如果任务完成，返回结果（不关闭浏览器）
        if (toolName === "finish_task") {
          console.log("最终结果:", args.result);
          return args.result;
        }

        // 3. 等待页面响应
        page = getActivePage(browser);
        await page.waitForTimeout(1000);

        // 4. 获取操作后的新页面状态（刷新 page 引用）
        page = getActivePage(browser);
        const newState = await getPageState(page);

        // 5. 检测是否遇到了验证/拦截页面
        if (await detectVerificationPage(page)) {
          await waitForManualVerification(rl);
          page = getActivePage(browser);
          const restoredState = await getPageState(page);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `工具执行结果: ${result}\n\n⚠️ 遇到验证页面，已手动完成验证。\n操作后的页面 URL: ${page.url()}\n操作后可交互元素:\n${restoredState}`
          });
          continue;
        }

        // 6. 将工具执行结果和新状态反馈给 LLM
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `工具执行结果: ${result}\n\n操作后的页面 URL: ${page.url()}\n操作后可交互元素:\n${newState}`
        });
      }
    }

    // 检查智能终止条件
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      console.log(`❌ 连续 ${MAX_CONSECUTIVE_FAILURES} 次操作失败`);
      return `连续 ${MAX_CONSECUTIVE_FAILURES} 次操作失败，任务终止。请检查任务描述是否正确，或手动操作后重试。`;
    }
    if (recentOps.length >= MAX_IDENTICAL_OPS && recentOps.every(op => op === recentOps[0])) {
      console.log(`❌ 连续 ${MAX_IDENTICAL_OPS} 次执行相同操作，陷入循环`);
      return `连续 ${MAX_IDENTICAL_OPS} 次执行相同操作 "${recentOps[0]}"，可能陷入循环，任务终止。请尝试调整任务描述。`;
    }
  }

  return "已达到最大循环次数（安全上限），任务终止。";
}

// 6. 持久会话 REPL：浏览器保持打开，等待连续指令
async function runSession() {
  const browser: Browser = await chromium.launch({ headless: false });
  // 显式创建浏览器上下文，然后打开一个初始空白页
  const context = await browser.newContext();
  await context.newPage();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log("🌐 浏览器已启动。输入任务开始操作，输入 exit/quit 退出。\n");
  console.log("   格式: [URL] 任务描述  (URL 可选，省略则从当前页面开始)\n");

  const askTask = (): Promise<string> => {
    return new Promise(resolve => {
      rl.question("🧭 请输入任务: ", resolve);
    });
  };

  while (true) {
    const input = (await askTask()).trim();
    if (!input) continue;
    if (["exit", "quit"].includes(input.toLowerCase())) break;

    // 解析: 如果输入以 http:// 或 https:// 开头，提取 URL 和任务
    const urlMatch = input.match(/^(https?:\/\/\S+)\s+(.*)/);
    const { startUrl, task } = urlMatch
      ? { startUrl: urlMatch[1], task: urlMatch[2] }
      : { startUrl: undefined, task: input };

    console.log(`\n执行任务: ${task}`);
    try {
      const result = await runAgent(browser, task, startUrl, rl);
      console.log(`✅ 任务完成: ${result}\n`);
    } catch (error: any) {
      console.log(`❌ 任务出错: ${error.message}\n`);
    }
  }

  rl.close();
  await browser.close();
  console.log("浏览器已关闭，会话结束。");
}

runSession();
