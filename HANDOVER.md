# 交接文档 —— Steam 游戏推广视频一键生产工具

> 给接手本项目的另一个 DSH 会话。本文件跟随仓库（HANDOVER.md），
> 同时也可单独发送。**开工前先完整读一遍本文 + 仓库 README.md**。
> 单文件服务器源码：`steam-video-downloader.mjs`（约 4140 行，零 npm 依赖）。

---

## 0. 项目一句话

单机 Web 工具：粘贴 Steam 链接批量下载宣传视频素材 → 抓价格/折扣/好评率/Key 价 →
上传分段真人配音 + 文案 → 本地 whisper 识别对齐生成字幕 → **一键合成完整成片**
（片头混剪 + 各游戏段[字幕+卡片] + 片尾混剪 + 省流总表）→ 导出**剪映微调素材包**。

---

## 1. 工程布局（仓库根 = `E:\DeepSeekHarness\Steameditingtoolsforgamediscounts`）

| 路径 | 说明 |
|---|---|
| `steam-video-downloader.mjs` | **唯一源码**：HTTP 服务 + 全部后端逻辑 + 内嵌 HTML/CSS/前端 JS（约 4140 行） |
| `bin\ffmpeg.exe` | 内置 ffmpeg（Windows x64 ~98MB，gitignored，Release 附件分发） |
| `sherpa-onnx\` | 本地 ASR 运行时+模型（gitignored；`runtime\sherpa-onnx-v1.13.7-...\bin\sherpa-onnx-offline.exe` + `models\whisper-small-int8\`） |
| `lib\STCharacters.txt` | OpenCC 简繁对照表（whisper 识别文本 繁体→简体 用） |
| `start-steam-video.cmd` | 双击启动（`node --use-system-ca steam-video-downloader.mjs`） |
| `README.md` | 完整功能文档 + 分步教程（用户视角） |
| `.gitignore` | bin/ffmpeg.exe、sherpa-onnx/、.tmp*/ 不入库 |

**运行**：双击 `start-steam-video.cmd` → http://localhost:8898（默认端口，env `PORT` 可换）。
服务器带 `--use-system-ca` 自重启逻辑（信任 Windows 证书库，Steam 证书校验用）。

---

## 2. 用户真实环境事实（这台机器）

- 素材目录：`E:\worddeepseek\videocut\material`（下载素材落这）
- 配音目录：`E:\worddeepseek\videocut\voice`；成品目录：`E:\worddeepseek\videocut\product`；Excel：`videocut\excel`
- 浏览器：Edge（装有 SteamTools 类扩展，其 PYTools 接口被 SteamPY Key 价抓取复用——见 §8）
- Git：本地 commit 可用；**push 由用户在**自己终端执行**（仓库级 sslCAInfo + credential.manager）
- 用户当前不在（回家几天），接手会话先按本文 + 用户新留言推进，不要假设用户在线 push

---

## 3. ⚠️ DSH 沙箱环境约束（写测试代码前必读）

本会话运行于文件沙箱 **workspace-write**：

1. **只能写 `E:\DeepSeekHarness` 下**。后台跑的 Node 服务器进程同样受限。
   - 一切写类测试：目录建在 `E:\DeepSeekHarness\.xxx-test\`，用完删除。
   - `E:\worddeepseek\...` **只读可以**（列表/读文件 OK），写会被拒。真实目录流程无法在本沙箱端到端验证，只能验证逻辑等价。
2. **spawn 子进程不能通过管道(stdout/stderr pipe)捕获输出**（EPERM）。源码里所有 ffmpeg/sherpa spawn 已用 `stdio: ['ignore','ignore', errFd]`（fd 重定向到临时文件）规避——**新加 spawn 调用必须沿用此模式**，不要 `exec()` 捕获 stdout。
3. PowerShell 内联引号/中文转义极易出错 → 复杂测试一律写成 `.cjs`/`.mjs` 脚本文件执行（本文件 CJS 用 `.cjs`，`.mjs` 是 ESM 无 require）。
4. 端口测试：用 `PORT=8899` 之类避开 8898 冲突；测完 kill 后台 job 并确认端口释放。
5. 中文文件名/内容测试：不要用 PowerShell 拼 JSON，Node 脚本里直接写中文字符串没问题。

---

## 4. ⚠️ 前端代码验证方法（血泪教训）

页面 HTML/CSS/JS 全部内嵌在 `.mjs` 的模板字符串（PAGE）里：

- **`node --check steam-video-downloader.mjs` 只能查外层 JS 语法，查不到内嵌 `<script>` 的错误！**
- 历史事故：成片面板渲染函数一个三元括号错 → 整页内嵌脚本语法错误 → **页面所有按钮全部失灵**（脚本完全没执行），`node --check` 还通过。
- **任何前端改动后必须做内嵌脚本语法检查**：
  ```powershell
  node -e "const fs=require('fs');const t=fs.readFileSync('steam-video-downloader.mjs','utf8');const s=t.indexOf('<script>');const e=t.indexOf('</script>',s);fs.writeFileSync('E:/DeepSeekHarness/.page-check.js',t.slice(s+8,e))"
  node --check E:\DeepSeekHarness\.page-check.js
  ```
  并校验 getElementById 引用的 id 都存在于 HTML、onclick 内联函数都有顶层声明（可参考历史做法写小脚本比对）。
- 前端 JS 编码风格（保持全文件一致）：**不用反引号**（PAGE 模板用 String.raw 包裹，反引号会冲突）、`var` + `function` 风格、字符串拼接 HTML、字符串内中文直接写（文件必须 UTF-8）。
- 修改后重启服务器再 fetch 页面（HTTP 200 + 关键块包含）冒烟。

---

## 5. 源码地图（函数名定位即可，行号会漂移）

**后端路由**：文件末尾 `server.on('request')` 里 `/api/xxx` 分派（搜 `p === '/api/`）。async handler 要 `.catch((e) => json(res, 500, ...))`。

**配音相关**
- `handleVoiceUpload`：POST `/api/voice/upload`。**可靠上传机制**：写 `名字.随机token.part` 临时文件 → 完整收完 → 删旧文件+rename（重试 4×500ms 应对占用）→ 成功后清理目录 >1h 孤儿 .part；Windows 非法字符/保留名预检；断连只清理自己的 .part，绝不破坏已存在正式文件。
- `handleVoiceList`：列表（异步，含每文件 `dur` 秒数，优先同名 .srt 时长否则实测）。
- `cleanupVoiceOrphans` / `probeDurations`：孤儿清理 / 并发探测时长（4 并发）。

**字幕（文案→srt）**
- `handleSubtitleGenerate`：转 16k wav → `runWhisperAsr`（sherpa-offline，逐行 JSON 输出解析）→ `alignScriptToSegments`（按文案句长比例分配 whisper 时间轴）→ `buildSrt` 落盘（与配音同目录同名 .srt）。
- `parseSrtCues` / `parseSrtDuration` / `toSrtTime`：srt 解析工具。

**成片（核心流水线）**
- `handleComposeTimeline`：POST `/api/compose-timeline`（**页面「自动贴合成片」用的就是它**）。
  - 装配：`voices[{path,isHead?}]` + `materials[{path,start,loop}]`。isHead 须在第 1 段（否则 400）；无 isHead 时沿用旧推断（voices=materials+1 → 首段为片头）。games（长度=素材段数）可选驱动片尾总表 + 自动卡片。
  - 段剪辑：`clipSegment(ff, mat, start, segLen, loop, seq, outPath)` —— 足够则流拷贝直剪；**不够且 loop=true 用 `-stream_loop -1 -i mat -ss start -t segLen` 循环补播**（实测：每轮都从 start 起播，重编码帧精确 segLen；loop=false 则报错提示）。
  - 画面合成：统一尺寸（`probeVideoSize` + `scaleFilterTo` 等比缩放+黑边 pad，**不同分辨率素材/总表/混剪混排必需**，否则 xfade `-22`）→ fps 归一 → xfade 链（transition>0）或 concat（硬切）。
  - 卡片自动叠加：`buildCardFilters(g, startSec, endSec)` 生成 drawtext 滤镜挂在每游戏段窗口。
  - 片头/片尾混剪：`pickFreeClips(materialsUsed, targetDur, clipLen)` 优先「未用区间」，**不足则兜底复用正片画面**（不再报"素材未用片段不足"）；`renderMontage(clips, out)` 内部也统一尺寸。
  - 片尾总表：`renderTableVideo(games, dur, out)`。
  - 时间轴：durs=[片头?, 各段, 片尾, 总表]；段时长=配音时长+padding；offset 减转场重叠；配音 `adelay` 贴入 + `amix`；返回 `windows[]`（label/startMs/endMs 供卡片联动与前端展示）。
  - 剪映素材包：outDir 下 `xxx_剪映素材包\`（各段画面+配音+对齐 srt+组装说明.txt，exportKit=false 可关）。
  - 可选 burnSubs：合并各段 srt 偏移 → `subtitles=...:fontsdir='C\:/Windows/Fonts':force_style=...` 烧录。
  - 注意 `tailSeconds`/`tableSeconds` 用 `Number(payload.x) || 6`，**显式传 0 无法关闭**（既有行为，未改）。

**其余接口**
- `handleComposeAuto`：旧接口（无前端页面引用），保留兼容。
- `handleCompose` / `composeVideos`：剪辑拼接（流拷贝 concat，timescale 归一）。
- `handleCardsOverlay`：成片后单独叠卡片（C1 面板）。
- Steam 抓取：appdetails API、appreviews?json=1、商店页 HTML 解析（`"tags":[...]`、`name="subid" value=NNN`）、`handleSteamCards`。
- `handleMaterials`（带 dur）/ `handleFiles` / `handleOpenFolder` / `handleConfig`。
- Excel：`handleExcelUpload`/`handleExcelPreview`（零依赖 xlsx zip 解析）。

**前端分区**（页面内自上而下）：下载作业区 → 素材列表 → 游戏数据(Excel/Steam) → 配音上传面板 → 文案字幕面板 → **成片配队面板(autoRows)** → 卡片面板 → 剪辑拼接面板。

---

## 6. 最近关键改动（git log，本地已提交；push 由用户做）

```
69896c2 修复页面全部按钮失灵（内嵌脚本三元括号语法错误）   ← 最新，如未 push 提醒用户
1fe0c10 成片自由配队+素材循环补播（配队编辑器 UI + clipSegment 循环 + 分辨率统一 + 混剪兜底）
5846303 配音上传保存失败修复（token 临时文件/占用重试/非法名校验/孤儿清理/重名拦截）
afad6bf 配音上传可靠性（.part 落盘 + json/html 断连防护 + 前端并发2/超时/自动重试/手动重试）
19e913c README 详细教程
783495a SteamPY Key 价接入
…（更早：字幕/烧录/素材包/卡片/转场/完整时间线等）
```

---

## 7. 用户工作流（新需求围绕它）

1. Steam 链接（Excel 或直抓）→ 下载素材（素材名 = `日期_游戏名_视频素材.mp4`，`parseGameNameFromFile` 解析游戏名）
2. 抓游戏数据（顺序=段落顺序）；配音 `01_开场白`、`02_游戏A`…（上传面板上传；顺序即配对）
3. 文案→字幕（本地 ASR，软字幕 .srt 与配音同名同目录）
4. **成片面板（配队编辑器）**：载入素材与配音 → 每行=一段配音，拖动/↑↓排序，行内下拉连素材（可重复用同一素材），第 1 段可勾「片头开场(混剪)」（取消则按普通段自选素材，解决"01 与下一素材重叠"），每行可选「不足循环补播」；生成完整成片 + 剪映素材包
5. 剪映微调（素材包导入）或勾烧录字幕出最终 mp4

---

## 8. 技术要点/踩坑速查（改到相关处必看）

- **ffmpeg filter 字符串两层转义**：JS 模板 → filter 参数里 `:` 要写 `\:`、`%` 写全角 `％`（drawtext/总表文本极易踩）、颜色必须 6 位 hex（`#444444` 不能 `#444`）、`fontsdir` 路径冒号转义 `C\:/Windows/Fonts`。总表/卡片文字走这些路径，改动后务必实测渲染输出（失败常见特征：ffmpeg 退出码非 0 或 moov 缺失）。
- **xfade**：输入须同分辨率同 fps。已统一：`[i:v]fps=N,scale=W:H:force_original_aspect_ratio=decrease,pad=W:H:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p`。
- **concat demuxer 流拷贝**：跨 fps 会时间戳错乱 → 需 `-video_track_timescale 15360` 归一；或用 filter concat（重编码）。
- **循环补播**：`-stream_loop -1 -i in -ss S -t L` 语义已验证：每轮从 S 起播、输出帧精确 L 秒（重编码）。
- **whisper 识别**：sherpa 输出逐行 JSON 到 stdout→（代码里重定向 fd 文件）；文本经 `simplifyText`（lib/STCharacters 简繁）处理。
- **SteamPY Key 价**：`https://steampy.com/xboot/common/plugIn/getGame?subId=<商店页真 subid>&appId=<appid>&type=subid` → `result.keyPrice`。商店页 subid 在 `<input type="hidden" name="subid" value="NNN">`。Key 价是**实时市场价，会波动**——README 已提醒用户录视频当天抓取。
- **上传可靠性**已在 §5 描述，改动上传链路时保持"临时文件+成功才落盘+断连不破坏正式文件+json 断连不崩"四原则；`json()/html()` 已加 `res.on('error',...)` + try/catch。
- **Windows rename 不能覆盖已存在文件** → 先删再改；删除/改名遇 EPERM/EBUSY（剪映/播放器/资源管理器预览占用）要重试并给用户可读提示。

---

## 9. 测试方法速记（沙箱内可行）

1. 语法：`node --check`（外层）+ §4 抽取脚本检查（前端）。
2. 起服务：后台 pwsh job 跑 `node steam-video-downloader.mjs`（PORT 默认 8898；多个服务并存时错开端口）。
3. 素材造数：ffmpeg `testsrc=duration=4:size=320x180:rate=30` 生成短视频；`sine=frequency=440:duration=5` 生成配音 wav。
4. 接口测：写 `.cjs` 脚本用 `http.request` 直打（中文无转义烦恼），断言状态码+关键字段。
5. 端到端模板参考历史：上传可靠性测试（并发同名/中断/占用）、compose 测试（循环/片头/总表/窗口时长）。**所有测试目录用 `E:\DeepSeekHarness\.xxx`，测完删除**；注意清掉项目根 `.tmp_*_*` 残留目录（gitignore 已忽略，但保持干净）。
6. 前端按钮可用性：除语法检查外，最好用真实浏览器让用户复测（本环境无浏览器 DOM 执行）。

---

## 10. 交接时未决/注意点

- **git push**：最新提交可能未推送，见到用户后提醒 `git push`（用户终端操作）。
- **Release 附件**：README 声称 `ffmpeg-win-x64.zip`/`sherpa-asr-win-x64.zip` 走 GitHub Release 分发（bin 与 sherpa-onnx gitignored 不随仓库）。若用户要求整包分发，需要打包脚本/说明——目前没有，是潜在工作项。
- 用户近期诉求轨迹：上传可靠性（已完）→ 成片自由配队+素材循环（已完）→ 现在回家，**接手会话以用户新留言为准**，不确定就先问。
- 默认目录相关环境变量：`PORT`、`EXCEL_DIR`（默认 `E:/worddeepseek/videocut/excel`）；成片默认成品目录 `E:/worddeepseek/videocut/product`。
- 遗留小事项（不影响使用，可顺手处理）：`.tmp_auto_*` 残留目录在项目根（13:41-13:55 生成，来源不明，gitignore 已忽略）；`tailSeconds/tableSeconds` 传 0 无法关闭的默认值语义。

---

## 11. 给接手 DSH 的守则

1. 先读 README.md（用户视角功能全貌）再动代码。
2. 所有改动集中在 `steam-video-downloader.mjs`；保持单文件、零 npm 依赖、UTF-8、前端 JS 无反引号。
3. 前端改动必须做 §4 的抽取语法检查（这个坑已经爆过一次）。
4. 后端 spawn 一律 fd 重定向；写文件测试一律 workspace 内；真实目录只读。
5. 改完本地 `git commit`（信息用中文概括），push 留给用户；README 与功能同步更新（用户看重文档）。
6. 不要随意改协议破坏旧客户端兼容；加字段向后兼容（历史例子：voices 加 isHead 可选、materials 加 loop 可选）。
7. 大改动先列 todo 分步，完成后端到端测试再收尾；测试产物清理干净。
