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
      description: "获取当前页面的概览信息（标题、URL、页面标题/区域文本、关键规则/要求），用于判断当前所在页面和任务是否完成",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "在当前页面等待指定的秒数。用于需要在页面停留的场景（如：等待视频播放、等待倒计时、等待页面渲染完成、满足页面要求的停留时长等）",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "等待的秒数，例如 60 表示等待1分钟" },
          reason: { type: "string", description: "等待的原因，例如'页面要求停留60秒'或'等待视频加载完成'" }
        },
        required: ["seconds"]
      }
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
          // 辅助：格式化秒数为 MM:SS
          const fmtTime = (s: number): string => {
            if (isNaN(s) || !isFinite(s) || s < 0) return "--:--";
            const min = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return `${min}:${sec.toString().padStart(2, "0")}`;
          };

          // 辅助：元素是否可见
          const isVisible = (el: Element): boolean => {
            const style = window.getComputedStyle(el);
            if (style.display === "none" || style.visibility === "hidden") return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          };

          // === 标题 ===
          const headings: string[] = [];
          document.querySelectorAll("h1, h2, h3, h4, .title, [class*='title'], [class*='header']").forEach(el => {
            const t = (el as HTMLElement).innerText?.trim().slice(0, 80);
            if (t) headings.push(t);
          });

          // === 正文 ===
          const mainText = document.body?.innerText?.slice(0, 1000) || "";

          // === 规则/要求提取 ===
          const ruleKeywords = /(注意|提示|说明|规则|要求|重要|条件|限制|警告|必须|需要|至少|最多|不得|禁止|步骤|流程|指南|分钟|秒|小时|每天|每日|每周|完成|未完成|待完成|剩余|进度|状态|倒计时|截止|期限|有效期|次数|机会|上限|下限|累计\d+|总共|合计|通过|note|warning|important|caution|hint|info|tip|required|must|should|need|condition|requirement|rule|instruction|step|completed|pending|remaining|progress|status|deadline|expir|limit|minimum|maximum)/i;
          const seenRules = new Set<string>();
          const rules: string[] = [];
          document.querySelectorAll("p, li, div, span, td, .rule, .requirement, .notice, .tip, [class*='rule'], [class*='tip'], [class*='notice'], [class*='score'], [class*='point'], [class*='requirement'], [class*='condition'], [class*='desc']").forEach(el => {
            const t = (el as HTMLElement).innerText?.trim();
            if (t && t.length >= 8 && t.length < 400 && ruleKeywords.test(t)) {
              const dedupKey = t.slice(0, 60);
              if (!seenRules.has(dedupKey)) {
                seenRules.add(dedupKey);
                rules.push(t.slice(0, 250));
              }
            }
          });

          // === 动态状态：媒体（video/audio）===
          const media: Record<string, any>[] = [];
          document.querySelectorAll("video, audio").forEach(el => {
            if (!isVisible(el)) return;
            const m = el as HTMLMediaElement;
            const dur = m.duration;
            const cur = m.currentTime;
            const pct = isFinite(dur) && dur > 0 ? Math.round((cur / dur) * 100) : null;
            // 尝试获取标签
            let label = m.getAttribute("aria-label") || m.getAttribute("title") || "";
            if (!label) {
              const heading = m.closest("section, article, div, li")?.querySelector("h1, h2, h3, h4, h5, strong, .title, [class*='title']");
              if (heading) label = heading.textContent?.trim().slice(0, 40) || "";
            }
            media.push({
              tag: m.tagName.toLowerCase(),
              label: label.slice(0, 50),
              playing: !m.paused && !m.ended,
              ended: m.ended,
              current: fmtTime(cur),
              duration: fmtTime(dur),
              progress: pct !== null ? `${pct}%` : "未知",
              muted: m.muted,
            });
          });

          // === 动态状态：进度条（<progress> / role="progressbar"）===
          const progress: Record<string, any>[] = [];
          document.querySelectorAll("progress, [role='progressbar']").forEach(el => {
            if (!isVisible(el)) return;
            let label = el.getAttribute("aria-label") || el.getAttribute("title") || "";
            let value: number | null = null;
            let max: number | null = null;
            let pct = "";

            if (el.tagName.toLowerCase() === "progress") {
              const p = el as HTMLProgressElement;
              value = p.value;
              max = p.max;
              if (p.max > 0) pct = `${Math.round((p.value / p.max) * 100)}%`;
            } else {
              const now = el.getAttribute("aria-valuenow");
              const ariaMax = el.getAttribute("aria-valuemax");
              const ariaText = el.getAttribute("aria-valuetext");
              if (now) value = parseFloat(now);
              if (ariaMax) max = parseFloat(ariaMax);
              if (ariaText) pct = ariaText;
              else if (value !== null && max && max > 0) pct = `${Math.round((value / max) * 100)}%`;
            }

            if (!label) {
              const parent = el.closest("div, section, li");
              if (parent) {
                const labelEl = parent.querySelector("span, label, strong, em, h4, h5, h6");
                if (labelEl) label = labelEl.textContent?.trim().slice(0, 40) || "";
              }
            }
            if (!label) label = el.textContent?.trim().slice(0, 40) || "";

            progress.push({ label: label.slice(0, 50), value, max, pct });
          });

          // === 动态状态：可见倒计时/计时器文本 ===
          const timerPatterns = [
            /\d{1,2}:\d{2}(:\d{2})?/,           // MM:SS or HH:MM:SS
            /倒计时\s*\d+/,
            /剩余\s*\d+\s*(秒|分钟|小时|天)/,
            /还剩\s*\d+\s*(秒|分钟|小时|天)/,
            /countdown\s*\d+/i,
            /remaining\s*\d+/i,
            /\d+\s*(seconds?|minutes?|hours?)\s*(remaining|left)/i,
          ];
          const seenTimers = new Set<string>();
          const timers: string[] = [];
          document.querySelectorAll("span, div, p, .timer, .countdown, [class*='timer'], [class*='countdown'], [class*='time']").forEach(el => {
            if (!isVisible(el)) return;
            const t = (el as HTMLElement).innerText?.trim();
            if (!t || t.length > 50) return;
            for (const pat of timerPatterns) {
              if (pat.test(t)) {
                const key = t.slice(0, 30);
                if (!seenTimers.has(key)) {
                  seenTimers.add(key);
                  timers.push(t.slice(0, 40));
                }
                break;
              }
            }
          });

          return {
            title: document.title,
            url: window.location.href,
            headings: [...new Set(headings)].slice(0, 15),
            rules: rules.slice(0, 20),
            bodyPreview: mainText.replace(/\n{3,}/g, "\n\n"),
            media,
            progress,
            timers,
          };
        });

        // === 组装输出 ===
        const rulesSection = info.rules.length > 0
          ? `\n  ⚠️ 关键规则/要求:\n${info.rules.map(r => `    "${r}"`).join("\n")}`
          : "\n  (未检测到明确的规则/要求文本)";

        // 动态状态段：只在有内容时才输出
        const dynamicLines: string[] = [];
        if (info.media.length > 0) {
          const mediaStrs = info.media.map(m => {
            const state = m.ended ? "已结束" : m.playing ? "播放中" : "已暂停";
            const label = m.label ? ` "${m.label}"` : "";
            return `${m.tag}${label} ${state} ${m.current}/${m.duration} (${m.progress})${m.muted ? " [静音]" : ""}`;
          });
          dynamicLines.push(`  媒体:\n${mediaStrs.map(s => `    ${s}`).join("\n")}`);
        }
        if (info.progress.length > 0) {
          const progStrs = info.progress.map(p => {
            const label = p.label ? ` "${p.label}"` : "";
            return `${label} ${p.pct || `${p.value}/${p.max}`}`;
          });
          dynamicLines.push(`  进度:\n${progStrs.map(s => `    ${s}`).join("\n")}`);
        }
        if (info.timers.length > 0) {
          dynamicLines.push(`  计时:\n${info.timers.map(t => `    "${t}"`).join("\n")}`);
        }
        const dynamicSection = dynamicLines.length > 0
          ? `\n动态状态:\n${dynamicLines.join("\n")}`
          : "";

        return `页面概览:
  URL: ${info.url}
  标题: ${info.title}
  页面区域:\n${info.headings.map(h => `  - ${h}`).join("\n")}${rulesSection}${dynamicSection}
  正文预览:\n${info.bodyPreview}`;
      }

      case "wait": {
        const seconds = Math.min(Math.max(args.seconds || 1, 1), 300); // 1-300秒
        const reason = args.reason || "未说明";
        console.log(`⏳ 等待 ${seconds} 秒... (${reason})`);
        await page.waitForTimeout(seconds * 1000);
        return `已等待 ${seconds} 秒（原因：${reason}）。如果还需要继续等待，可以再次调用 wait。`;
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

// 2. 页面状态提取：分类提取可交互元素 + 输入元素 + 标题，帮助 LLM 理解页面
async function getPageState(page: Page): Promise<string> {
  // tsx 转译会在 Playwright 序列化的函数中注入 __name() 调用，需提前在浏览器环境定义
  await page.evaluate("var __name = function(fn, name) { return fn; };");
  return await page.evaluate(() => {
    const seen = new Set<string>();
    const captured = new Set<Element>();

    const inViewport = (rect: DOMRect): boolean => {
      if (rect.width <= 0 || rect.height <= 0) return false;
      if (rect.bottom < -200 || rect.top > window.innerHeight + 200) return false;
      return true;
    };

    const buildDesc = (el: Element, tag: string): string | null => {
      const rect = el.getBoundingClientRect();
      if (!inViewport(rect)) return null;

      const htmlEl = el as HTMLElement;
      const text = htmlEl.innerText?.trim().slice(0, 50) || "";
      const placeholder = htmlEl.getAttribute("placeholder") || "";
      const ariaLabel = htmlEl.getAttribute("aria-label") || "";
      const href = htmlEl.getAttribute("href")?.slice(0, 60) || "";
      const role = htmlEl.getAttribute("role") || "";
      const type = htmlEl.getAttribute("type") || "";
      const cls = htmlEl.className?.toString().slice(0, 40) || "";
      const clsLower = cls.toLowerCase();

      const key = `${tag}|${text}|${Math.round(rect.x)}|${Math.round(rect.y)}`;
      if (seen.has(key)) return null;
      seen.add(key);

      let desc = `<${tag}`;
      if (text) desc += ` text="${text}"`;
      if (placeholder) desc += ` placeholder="${placeholder}"`;
      if (ariaLabel) desc += ` aria-label="${ariaLabel}"`;
      if (href) desc += ` href="${href}"`;
      if (role) desc += ` role="${role}"`;
      if (type && type !== "text") desc += ` type="${type}"`;
      // 只展示有意义的 class（交互/导航相关）
      if (clsLower && /nav|menu|tab|btn|button|link|login|sign|auth|toolbar|header|top|side|item|action|click|search|icon|logo|user|avatar|dropdown|popup|modal|drawer/.test(clsLower)) {
        desc += ` class="${cls}"`;
      }
      desc += `>`;
      return desc;
    };

    const collect = (selectors: string[], category: string, target: string[]): void => {
      selectors.forEach(selector => {
        try {
          document.querySelectorAll(selector).forEach(el => {
            if (captured.has(el)) return;
            const tag = el.tagName.toLowerCase();
            const desc = buildDesc(el, tag);
            if (desc) {
              target.push(`[${category}] ${desc}`);
              captured.add(el);
            }
          });
        } catch {}
      });
    };

    // === Phase 1: 已知可交互元素的选择器 ===
    const interactiveSelectors = [
      // 核心可交互
      "a", "button", "summary", "details",
      // ARIA 交互角色
      "[role='button']", "[role='link']", "[role='tab']", "[role='menuitem']",
      "[role='option']", "[role='treeitem']", "[role='switch']", "[role='checkbox']",
      "[role='radio']", "[role='combobox']", "[role='searchbox']", "[role='slider']",
      // 属性
      "[onclick]", "[href]", "[tabindex]",
      "[data-action]", "[data-href]", "[data-url]", "[data-click]", "[data-link]",
      "[data-route]", "[data-path]", "[data-to]",
      // 导航区域
      "nav a", "nav button", "nav span", "nav div", "nav li",
      "header a", "header button", "header span", "header div",
      "[class*='navbar'] a", "[class*='navbar'] button", "[class*='navbar'] span", "[class*='navbar'] div",
      "[class*='nav'] a", "[class*='nav'] button", "[class*='nav'] span",
      "[class*='menu'] a", "[class*='menu'] button", "[class*='menu'] span", "[class*='menu'] li",
      "[class*='toolbar'] a", "[class*='toolbar'] button", "[class*='toolbar'] span",
      "[class*='top-bar'] a", "[class*='top-bar'] button", "[class*='top-bar'] span", "[class*='top-bar'] div",
      "[class*='header'] a", "[class*='header'] button", "[class*='header'] span",
      "[class*='sidebar'] a", "[class*='sidebar'] button", "[class*='sidebar'] span", "[class*='sidebar'] div",
      "[class*='drawer'] a", "[class*='drawer'] button", "[class*='drawer'] span",
      "[class*='dropdown'] a", "[class*='dropdown'] button", "[class*='dropdown'] span", "[class*='dropdown'] li",
      "[class*='popup'] a", "[class*='popup'] button", "[class*='popup'] span",
      "[class*='modal'] a", "[class*='modal'] button", "[class*='modal'] span",
      // 列表项（常用于菜单/设置）
      "li a", "li button", "li span", "li div",
      "li[class*='item']",
      // class 名称启发式
      "[class*='btn']", "[class*='button']",
      "[class*='link']", "[class*='clickable']",
      "[class*='login']", "[class*='sign-in']", "[class*='signin']", "[class*='sign-up']", "[class*='signup']",
      "[class*='auth']", "[class*='account']",
      "[class*='action']", "[class*='click']",
      "[class*='entry']", "[class*='item']",
    ];

    const interactive: string[] = [];
    collect(interactiveSelectors, "可点击", interactive);

    // === Phase 2: 输入元素 ===
    const inputSelectors = [
      "input:not([type='hidden'])", "textarea", "select",
      "[role='textbox']", "[role='searchbox']", "[role='combobox']",
      "[contenteditable='true']",
    ];
    const inputs: string[] = [];
    collect(inputSelectors, "输入", inputs);

    // === Phase 3: cursor:pointer 扫描（捕获遗漏的 JS/CSS 驱动的可点击元素） ===
    const pointerElements: string[] = [];
    const scanElements = document.querySelectorAll("div, span, li, td, th, dt, dd, label, em, strong, i, b, u, p");
    let cursorChecks = 0;
    const MAX_CURSOR_CHECKS = 300;
    for (const el of scanElements) {
      if (captured.has(el)) continue;
      if (cursorChecks >= MAX_CURSOR_CHECKS) break;
      const rect = el.getBoundingClientRect();
      if (!inViewport(rect)) continue;
      const htmlEl = el as HTMLElement;
      const text = htmlEl.innerText?.trim();
      if (!text || text.length < 2) continue; // 跳过空元素和单字符
      cursorChecks++;
      const style = window.getComputedStyle(htmlEl);
      if (style.cursor === "pointer") {
        const tag = htmlEl.tagName.toLowerCase();
        const desc = buildDesc(el, tag);
        if (desc) {
          pointerElements.push(`[可点击] ${desc}`);
          captured.add(el);
        }
      }
    }

    // === Phase 4: 标题（页面结构上下文） ===
    const headingSelectors = ["h1", "h2", "h3", "h4"];
    const headings: string[] = [];
    collect(headingSelectors, "标题", headings);

    // === 组装输出：可交互优先 ===
    const result: string[] = [];
    if (interactive.length > 0) {
      result.push(`=== 可交互 (${interactive.length}) ===`);
      result.push(...interactive.slice(0, 120));
    }
    if (pointerElements.length > 0) {
      result.push(`\n=== 可交互-cursor扫描 (${pointerElements.length}) ===`);
      result.push(...pointerElements.slice(0, 40));
    }
    if (inputs.length > 0) {
      result.push(`\n=== 输入 (${inputs.length}) ===`);
      result.push(...inputs.slice(0, 15));
    }
    if (headings.length > 0) {
      result.push(`\n=== 标题 (${headings.length}) ===`);
      result.push(...headings.slice(0, 10));
    }

    // Fallback: 如果可交互元素太少，追加 body 文本预览
    if (interactive.length + pointerElements.length < 5) {
      const bodyText = document.body?.innerText?.slice(0, 400) || "";
      result.push(`\n=== 页面文本预览（可交互元素较少） ===\n${bodyText}`);
    }

    return result.join("\n") || "(页面为空或尚未加载)";
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
      content: `你是一个通用浏览器操作助手。你的核心能力是**理解任务**并**逐步执行**，而不是依赖预设的场景模板。

## 任务理解框架

收到任务后，先在心中完成拆解：

### 1. 明确目标
用户最终想要达成什么结果？常见的任务类型：
- **获取信息**：查找、阅读、提取页面中的特定内容
- **执行操作**：填写表单、提交数据、点击特定按钮完成流程
- **满足条件**：达到某个数量、停留足够时长、完成一系列步骤
- **状态确认**：检查某个东西是否存在、某个状态是否达成

### 2. 识别约束
任务中有哪些显式或隐式的要求？
- 有没有数量/时长/次数的限制？
- 有没有特定的操作顺序或路径要求？
- 有没有需要满足的前置条件？

### 3. 定义完成标准
什么现象说明任务已经完成？
- 页面出现了特定的内容或状态变化
- 某个条件被满足（数字达标、操作序列完成）
- 看到了确认/成功提示

## 执行循环

每一步都遵循：**观察 → 推理 → 行动 → 验证**

### 观察
- 调用 check_page 了解当前页面：URL、标题、页面结构
- 注意页面中的关键信息：说明文字、提示、规则、表单、列表等
- **关注动态状态**：check_page 会报告媒体播放状态（播放中/暂停/已结束）、进度条、倒计时 — 这些是判断任务进度的核心依据。例如视频已结束 → 可进入下一步；进度 50% → 任务进行中；倒计时未归零 → 继续等待
- 查看可交互元素列表，了解当前可用的操作

### 推理
- 当前页面和任务目标是什么关系？我在正确的位置吗？
- 页面上的信息对推进任务有什么帮助或限制？
- 我离目标还有多远？下一步应该做什么？

### 行动
- 选择最合适的工具执行操作
- 一次专注于一个操作，确保可控

### 验证
- 操作后的状态是否符合预期？查看反馈中的 URL 和媒体状态
- **涉及媒体（视频/音频）时**：点击链接后，先看反馈中的「媒体状态」确认是否开始播放。如果显示"已暂停"或没有媒体状态 → 需要点击播放按钮。确认播放中 → 再根据时长决定 wait 多久。视频显示"已结束" → 当前视频已完成，推进到下一个
- 如果失败：是定位问题还是逻辑问题？换一种策略重试
- 如果成功：按照原计划，下一步应该做什么？

## 操作原则

- **持续执行**：没有步骤数限制，一步步推进直到任务完成，不要因为步骤多而提前放弃
- **失败换思路**：同一种方式失败 2 次后必须换策略（换定位方式、先滚动、用 check_page 确认状态），不要机械重复
- **状态确认**：不确定当前页面状态时用 check_page，不要凭猜测做判断
- **避免死循环**：不要连续重复完全相同的操作；系统会检测 3 次连续失败或重复操作并自动终止
- **媒体先验证再等待**：不要盲目 wait。点击视频/音频链接后，操作反馈中会包含「媒体状态」，根据实际状态决策：未播放→点播放按钮，播放中→根据总时长计算 wait 秒数，已结束→当前完成，推进到下一个
- **wait 参数合理**：wait 的秒数应根据媒体总时长或页面规则来设定，不要随意设置。如果不确定等多久，用 check_page 查看页面规则或媒体时长

## 元素定位

- 优先从页面可交互元素列表中匹配目标文本
- 列表中找不到目标时（可能不在视口内），先 scroll_down 再看新列表
- 多次找不到时用 check_page 确认元素是否确实存在于页面中
- 操作失败时尝试不同的定位方式（精确文本/模糊文本/role/link/button/通用文本）

## 标签页管理

- 在当前标签页跳转用 navigate
- 需要同时查看多个页面用 new_tab
- 链接在新标签页打开时，用 list_tabs 检查并用 switch_tab 切换

## 任务完成

- 对照任务要求逐一检查：所有条件都满足了吗？
- 满足 → 调用 finish_task，简短说明完成情况
- 不确定 → check_page 确认后再判断
- 涉及登录/验证的任务：手动验证通过后页面通常会自动跳转，check_page 确认即可`
    },
    {
      role: "user",
      content: `任务: ${task}\n\n当前 URL: ${page.url()}\n当前页面可交互元素:\n${await getPageState(page)}\n\n[重要提醒] 请跟踪你的进度：如果某个子任务已完成（如视频已播放结束、页面已处理过），立即推进到下一个子任务，不要重复已完成的操作。`
    }
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 200; // 安全网，防止真正死循环（正常任务不应触发）
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
  // 记录最近操作（工具名+参数），用于检测重复操作
  const recentOps: string[] = [];
  const MAX_IDENTICAL_OPS = 3;

  // === 进度记忆：防止长对话中遗忘已完成步骤 ===
  const actionLog: string[] = [];
  const PROGRESS_INTERVAL = 8; // 每 8 轮注入一次进度摘要
  let lastProgressInjection = 0;

  const summarizeAction = (toolName: string, args: any, result: string): string => {
    const short = result.length > 50 ? result.slice(0, 50) + "..." : result;
    switch (toolName) {
      case "navigate": return `导航到 ${args.url}`;
      case "click_element": return `点击 "${args.name}" → ${short}`;
      case "type_text": return `在 "${args.label}" 输入文本`;
      case "scroll_down": return `向下滚动页面`;
      case "check_page": return `查看页面状态`;
      case "wait": return `等待 ${args.seconds}秒 (${args.reason || "未说明"})`;
      case "switch_tab": return `切换到标签页 ${args.identifier}`;
      case "new_tab": return `打开新标签页${args.url ? `: ${args.url}` : ""}`;
      case "close_tab": return `关闭当前标签页`;
      case "list_tabs": return `列出所有标签页`;
      case "finish_task": return `完成任务: ${args.result}`;
      default: return `${toolName} → ${short}`;
    }
  };

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`\n--- 循环 ${iterations} ---`);

    // 每次循环前动态获取当前活动页面（可能已切换标签页）
    page = getActivePage(browser);

    // 调用 LLM
    const response = await openai.chat.completions.create({
      model: "deepseek-v4-pro",
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

        // 记录到进度日志（finish_task 除外，它直接返回）
        if (toolName !== "finish_task") {
          actionLog.push(summarizeAction(toolName, args, result));
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

        // 4.5 轻量媒体状态检测（让 Agent 知道视频/音频是否在播放）
        let mediaStatus = "";
        try {
          const mediaInfo: string[] = await page.evaluate(() => {
            const items: string[] = [];
            document.querySelectorAll("video, audio").forEach(el => {
              const m = el as HTMLMediaElement;
              const style = window.getComputedStyle(m);
              if (style.display === "none" || style.visibility === "hidden") return;
              const rect = m.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) return;
              const state = m.ended ? "已结束" : m.paused ? "已暂停" : "播放中";
              const dur = isFinite(m.duration) && m.duration > 0 ? Math.round(m.duration) : null;
              const cur = Math.round(m.currentTime);
              const durStr = dur !== null ? `/${dur}秒` : "";
              items.push(`${m.tagName.toLowerCase()} ${state} ${cur}秒${durStr}`);
            });
            return items;
          });
          if (mediaInfo.length > 0) {
            mediaStatus = `\n媒体状态: ${mediaInfo.join("; ")}`;
          }
        } catch { /* 忽略媒体检测失败 */ }

        // 5. 检测是否遇到了验证/拦截页面
        if (await detectVerificationPage(page)) {
          await waitForManualVerification(rl);
          page = getActivePage(browser);
          const restoredState = await getPageState(page);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `工具执行结果: ${result}\n\n⚠️ 遇到验证页面，已手动完成验证。\n操作后的页面 URL: ${page.url()}${mediaStatus}\n操作后可交互元素:\n${restoredState}`
          });
          continue;
        }

        // 6. 将工具执行结果和新状态反馈给 LLM
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `工具执行结果: ${result}\n\n操作后的页面 URL: ${page.url()}${mediaStatus}\n操作后可交互元素:\n${newState}`
        });
      }
    }

    // === 定期注入进度摘要，防止 LLM 遗忘已完成步骤 ===
    if (actionLog.length > 0 && iterations - lastProgressInjection >= PROGRESS_INTERVAL) {
      const summary = actionLog.map((entry, i) => `${lastProgressInjection + i + 1}. ${entry}`).join("\n");
      messages.push({
        role: "user",
        content: `[任务进度回顾 — 以下是最近完成的操作，请勿重复：]\n已完成 ${lastProgressInjection + actionLog.length} 步操作：\n${summary}\n\n请检查：哪些子任务已经完成？还有哪些未完成？继续向目标推进，不要重复已完成的步骤。`
      });
      lastProgressInjection += actionLog.length;
      actionLog.length = 0; // 清空已注入的日志
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
