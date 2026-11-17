/** Local evidence extraction, not a semantic-completeness classifier. */
const LABELS = {
  target: ['目标/任务', 'Goal/task'], deliverable: ['交付物', 'Deliverable'],
  environment: ['使用环境', 'Environment'], background: ['背景', 'Background'],
  constraints: ['明确约束', 'Explicit constraint'], outputFormat: ['表达格式', 'Response format'],
  successCriteria: ['验收线索', 'Acceptance signal'],
};
const ACTION = /(?:做|开发|制作|创建|搭建|实现|美化|优化|改善|修复|排查|解决|设计|写|撰写|生成|分析|比较|总结|翻译|解释|整理|评估|安装|重构|改进|迁移|让|给(?:我)?|把.{1,80}(?:改|转|译)|\b(?:build|make|create|develop|implement|beautify|improve|fix|debug|design|write|generate|analy[sz]e|compare|summari[sz]e|translate|explain|review|install|refactor|convert)\b)/i;
const REQUEST = /^(?:(?:我(?:想|希望|打算|准备|需要)(?:要)?|想要|希望|打算|准备|需要|请你|请|帮我|给我|能否|可否|能不能|可以|麻烦|先|只|仅|再|然后|I\s+(?:want|need|would like)(?:\s+to)?|I['’]d like(?:\s+to)?|please|could you|can you|help me)\s*)+/i;
const NEGATIVE = /^(?:请|我|我们|I\s+|we\s+)?(?:不要|别|禁止|不能|不需要|不想|无需|不用|do not\b|don't\b|never\b|no need to\b)/i;
const ARTIFACT = /插件|扩展|脚本|应用|网页|网站|程序|组件|接口|报告|文章|邮件|计划|方案|清单|表格|演示文稿|(?:可行性)?分析|方向|代码|\b(?:plug-?in|extension|script|app(?:lication)?|website|webpage|component|API|report|article|email|plan|proposal|checklist|table|presentation|analysis|suggestions?|code)\b/ig;
const CREATE = /^(?:(?:目标|目的|任务|goal|objective|task)\s*[:：]\s*)?(?:做|开发|制作|创建|搭建|实现|写|撰写|生成|设计|给(?:我)?|build\b|make\b|create\b|develop\b|implement\b|write\b|generate\b|design\b|give\b)/i;
// A format name used as a task object (e.g. JSON parser) is not a response format.
const FORMAT = /(?:输出格式|回答格式|返回格式|格式|format)\s*[:：]\s*[^。！？!?;；\n]{1,60}|(?:输出(?:为|成)?|返回(?:为)?|使用|用|以|采用|\b(?:output(?:\s+as)?|return(?:\s+as)?|in|as)\b)\s*(?:一个|一份|a\s+)?(?:Markdown\b|JSON\b|CSV\b|YAML\b|HTML\b|PDF\b|PPTX?\b|DOCX\b|纯文本|分点|项目符号|表格|列表|plain text\b|bullet points?\b|table\b|list\b)/i;
const FORMAT_NAME = /Markdown|JSON|CSV|YAML|HTML|PDF|PPTX?|DOCX|纯文本|分点|项目符号|表格|列表|plain text|bullet points?|table|list/i;
const CONSTRAINT = /必须|不要|禁止|只用|仅用|不(?:得|能|允许|超过|使用|添加|改变|联网)|预算|截止|兼容|依赖|保持|保留|\b(?:must|do not|don't|only use|without|no new|at most|budget|deadline|compatible|preserve|keep)\b/i;
const ACCEPTANCE = /验收|成功标准|完成条件|测试通过|可以安装|可安装|可运行|\b(?:acceptance|success criteria|definition of done|tests? pass|installable|runnable)\b/i;

// Mask code while preserving UTF-16 offsets. Never interpret code samples as intent.
function proseMask(text) {
  return text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)|`[^`\n]*`|“[^“”\n]*”|「[^「」\n]*」|"[^"\n]*"/g, (code) => code.replace(/[^\r\n]/g, ' '));
}
function clauses(text) {
  const segmented = text.replace(/\.(?=\s|$)/g, ';');
  return [...segmented.matchAll(/[^。！？!?;；，,\r\n]+/g)].map((match) => {
    const lead = match[0].length - match[0].trimStart().length;
    return { text: match[0].trim(), start: match.index + lead };
  }).filter((part) => part.text);
}
function isTask(text) {
  const stripped = text.replace(REQUEST, '');
  if (NEGATIVE.test(text) || NEGATIVE.test(stripped)) return false;
  // A statement about wanting an action or a direct imperative; mentions alone are not tasks.
  const wantedArtifact = REQUEST.test(text) && /插件|扩展|报告|文章|邮件|计划|方案|\b(?:plug-?in|extension|report|article|email|plan|proposal)\b/i.test(stripped);
  const explicitDesire = /我(?:想|希望|需要)(?:要)?(?:做|开发|创建|让|把|写|改善)|\bI\s+(?:want|need)\s+to\b/i.test(text);
  return wantedArtifact || explicitDesire || (REQUEST.test(text) ? ACTION.test(stripped) : ACTION.test(text) && ACTION.exec(text)?.index === 0);
}

export function analyzeIntent(raw, locale = 'zh', profile = 'general') {
  const zh = locale === 'zh';
  const text = proseMask(raw);
  const parts = clauses(text);
  const recognizedFacts = [];
  const add = (key, start, length) => {
    if (recognizedFacts.some((fact) => fact.key === key)) return;
    recognizedFacts.push({ key, label: LABELS[key][zh ? 0 : 1], evidence: raw.slice(start, start + length), start, end: start + length });
  };
  const tasks = parts.filter((part) => {
    const labeled = /^(?:目标|目的|任务|goal|objective|task)\s*[:：]\s*(.+)/i.exec(part.text);
    return isTask(labeled ? labeled[1] : part.text);
  });
  const taskSet = new Set(tasks);
  for (const part of tasks) add('target', part.start, part.text.length);
  for (const part of parts) {
    const stripped = part.text.replace(REQUEST, '');
    const deliverableLabel = /^(?:交付物|产出|deliverable)\s*[:：]\s*/i.exec(part.text);
    const deliverableContent = deliverableLabel ? part.text.slice(deliverableLabel[0].length) : stripped;
    if (NEGATIVE.test(part.text) || NEGATIVE.test(stripped) || NEGATIVE.test(deliverableContent)) continue;
    const explicitDeliverable = Boolean(deliverableLabel);
    const wantsArtifact = /^(?:我(?:想|希望|需要)|想要|I['’]d like|I (?:want|need)|给我)/i.test(part.text)
      && /^(?:一?个|一?份|a\s+|an\s+)?(?:插件|扩展|报告|文章|邮件|计划|方案|plug-?in\b|extension\b|report\b|article\b|email\b|plan\b|proposal\b)/i.test(stripped);
    // Decide a creation context once, then scan only its bounded prefix. Historical
    // mentions, analysed quotations and late artifact words are not new deliverables.
    const countOrNounRequest = /^给我/.test(part.text) && !/^(?:解释|分析|总结|比较|修复|排查|翻译|评估|安装|重构)/.test(stripped);
    const creation = taskSet.has(part) && (CREATE.test(stripped) || wantsArtifact || countOrNounRequest);
    if (explicitDeliverable || creation) {
      const match = ARTIFACT.exec(part.text.slice(0, 200));
      ARTIFACT.lastIndex = 0;
      if (match) add('deliverable', part.start + match.index, match[0].length);
    }
    const format = FORMAT.exec(part.text);
    if (format) {
      const name = FORMAT_NAME.exec(format[0]);
      const after = part.text.slice(format.index + format[0].length);
      const explicitFormat = /^(?:输出|返回|(?:输出格式|回答格式|返回格式|格式|format)\s*[:：]|\b(?:output|return|in|as)\b)/i.test(format[0]);
      const presentation = /^\s*(?:来)?(?:给|回答|输出|返回|呈现|列出|提供|描述|写(?:一|个|份|篇)|生成(?:一|个|份|篇))/i.test(after);
      if (!/^\s*(?:解析器?|校验器?|验证器?|输入|数据|文件|parser\b|validator\b|input\b|data\b)/i.test(after) && (explicitFormat || presentation)) {
        add('outputFormat', part.start + format.index + (name?.index ?? 0), (name?.[0] ?? format[0]).length);
      }
    }
  }
  for (const part of parts) {
    if (CONSTRAINT.test(part.text) || /\bask before\b/i.test(part.text)) add('constraints', part.start, part.text.length);
    if (ACCEPTANCE.test(part.text) && !/^(?:验收|验收标准|成功标准|完成条件|acceptance|success criteria|definition of done)\s*[:：]?\s*[.]?$/i.test(part.text)) add('successCriteria', part.start, part.text.length);
    const background = /^(?:背景|现状|目前|现在|已有|项目是|context|background|currently|existing|we already have)\s*[:：]?\s*(.+)/i.exec(part.text);
    if (background && background[1].trim()) add('background', part.start, part.text.length);
  }
  // Only report explicitly named environments, not a guessed stack.
  const environment = /\b(?:DSH|DeepSeek Harness|Windows|macOS|Linux|Android|iOS|React|Vue|Node\.js)\b/i.exec(text);
  if (environment && tasks.length) add('environment', environment.index, environment[0].length);

  const clarifications = [];
  const ask = (id, question, reason, evidence = '') => clarifications.push({ id, question, reason, evidence });
  const taskText = tasks.map((part) => part.text).join('；');
  const all = parts.map((part) => part.text).join('；');
  const has = (key) => recognizedFacts.some((fact) => fact.key === key);
  if (!has('target')) {
    ask('intent', zh ? '你希望我围绕这段内容做什么？' : 'What would you like me to do with this content?',
      zh ? '本地规则未识别出明确动作，不等于你没有表达目标。' : 'Local rules did not recognize an action; this does not prove that your goal is missing.');
  } else if (/(?:做|开发|制作|写|创建)(?:一?个|一?份)?(?:东西|什么)[。.!]?$/i.test(taskText) || /\b(?:make|build|create|write)\s+something\s*$/i.test(taskText)) {
    ask('object', zh ? '这里想做的具体是什么？可以说说用途或举个例子。' : 'What would you like to make? A use case or example would help.',
      zh ? '你已表达要做一件事；这里只确认对象，不要求套用五项模板。' : 'You expressed an action; this only clarifies its object, without a five-part form.',
      /东西|什么|something/i.exec(taskText)?.[0] ?? '');
  } else if (/(?:这个|这段|this UI|this interface|this code)/i.test(taskText) && raw.length < 100 && !/```|截图|附图|附件|screenshot|attached|[:：]\s*\S/i.test(raw)) {
    ask('reference', zh ? '这里的“这/这个”具体指哪段内容或哪个界面？可提供描述或截图。' : 'What does “this” refer to? A description or screenshot would help.',
      zh ? '任务动作已表达；这里只确认指代对象，不假定它已随输入提供。' : 'The action is explicit; this only checks the referenced material, without assuming it was supplied.',
      /这个|这段|this UI|this interface|this code/i.exec(taskText)?.[0] ?? '');
  } else if (/(?:美化|好看|beautif|prettier|visual polish|easier on the eyes)/i.test(taskText) && !/方向|建议|可行性|文章|报告|邮件|\b(?:ideas|suggestions|feasibility|article|report|email)\b/i.test(taskText) && !/(?:配色|颜色|字体|间距|圆角|阴影|深色|浅色|布局|侧栏|侧边栏|对话区|输入框|截图|参考|theme|colou?r|font|spacing|radius|dark|light|layout|sidebar|screenshot|reference)/i.test(all)) {
    const ui = /交互界面|界面|交互|\bUI\b|interface/i.exec(taskText)?.[0];
    ask('visual-scope', zh ? `你最想美化${ui ? `“${ui}”的哪些部分` : '哪些部分'}？有没有喜欢的风格或参考图？` : 'Which parts should look different, and do you have a preferred style or reference?',
      zh ? '“美化”已是目标；这只是在确认具体方向，不要求你重新说明目标或交付物。' : 'Visual improvement is already the goal; this only narrows the direction, not the goal or deliverable.',
      /美化|好看|beautif\w*|prettier|visual polish/i.exec(taskText)?.[0] ?? '');
  } else if (/(?:优化|改善|改进|improve|optimi[sz]e)/i.test(taskText) && !/(?:速度|性能|延迟|内存|大小|可读|易读|可用|易用|无障碍|配色|颜色|字体|间距|布局|操作|步骤|点击|键盘|卡顿|重复|响应|speed|performance|latency|memory|readab|accessib|spacing|layout|click|keyboard|response)/i.test(all)) {
    ask('improvement-direction', zh ? '这次最想改善哪一种具体体验或问题？' : 'Which specific experience or problem should improve first?',
      zh ? '改进目标已表达，但“优化/改善”可能有不同方向；不擅自替你选定。' : 'Improvement is explicit, but its direction can vary; no direction is chosen for you.',
      /优化|改善|改进|improve\w*|optimi[sz]e\w*/i.exec(taskText)?.[0] ?? '');
  } else if (/(?:修复|排查|解决|\bfix\b|\bdebug\b)/i.test(taskText) && /报错|错误|问题|bug|error|issue/i.test(all) && !/堆栈|错误码|日志|复现|预期|实际|expected|actual|stack trace|steps to reproduce|error\s*[:：]|(?:报错|错误)\s*[:：]|TypeError|ReferenceError|\b[45]\d\d\b/i.test(all)) {
    ask('diagnostic-evidence', zh ? '能提供复现步骤或实际报错内容吗？' : 'Can you share reproduction steps or the actual error?',
      zh ? '修复任务已明确；具体报错能避免凭空猜测原因。' : 'The repair task is explicit; concrete evidence avoids guessing the cause.',
      /报错|错误|问题|bug|error|issue/i.exec(all)?.[0] ?? '');
  } else if (/(?:报告|文章|邮件|\b(?:report|article|email)\b)/i.test(taskText) && !/给|面向|读者|客户|老板|同事|团队|用户|评审|用于|用来|audience|for\s+(?:the\s+)?(?:team|client|customer|manager|review)|to\s+(?:the\s+)?(?:team|client|customer|manager)/i.test(all)) {
    ask('audience-purpose', zh ? '这份内容主要给谁看、用于什么场景？' : 'Who is this for, and where will it be used?',
      zh ? '交付物已经明确；读者或用途会影响内容取舍，不需要重复指定文件格式。' : 'The deliverable is explicit; audience or purpose can affect content, without requiring another file format.',
      /报告|文章|邮件|\b(?:report|article|email)\b/i.exec(taskText)?.[0] ?? '');
  } else if (/(?:翻译|\btranslate\b)/i.test(taskText) && !/译成|翻成|翻译成|(?:翻译|译)为(?:中文|英文|英语|日语|法语)|到(?:中文|英文|英语|日语|法语)|成(?:中文|英文|英语|日语|法语)|into\s+[a-z]+|to\s+(?:English|Chinese|Japanese|French|Spanish|German)/i.test(all)) {
    ask('translation-language', zh ? '希望翻译成哪种语言？' : 'Which language should it be translated into?',
      zh ? '翻译任务已明确；这里只确认目标语言。' : 'The translation task is explicit; this only asks for the target language.',
      /翻译|\btranslate\b/i.exec(taskText)?.[0] ?? '');
  }
  // No universal background/constraints/format/success checklist. No questions are also valid.
  return { recognizedFacts, clarifications: clarifications.slice(0, 2), profile };
}
