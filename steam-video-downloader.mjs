#!/usr/bin/env node
// steam-video-downloader.mjs
// Steam 游戏视频批量下载 + 剪辑拼接工具（网页版，零 npm 依赖，m3u8 能力完全内置）。
//
// 功能：
//   网页输入框里可以一次粘贴多个 Steam 商店链接（每行一个），自动识别每个链接的 appid，
//   逐个调用 Steam appdetails 接口拿到每个游戏的宣传视频列表，把"第一个视频"下载到本地。
//   Steam 现在只提供 HLS(.m3u8)/DASH(.mpd) 流地址：
//     - 解析 + 分片下载：Node 内置实现（信任系统证书，可正常访问 Steam 视频 CDN）
//     - 合并成 mp4：使用内置 ffmpeg（工具目录 bin/，或自动探测本机 ffmpeg）
//   无需安装/配置任何外部 m3u8 解析器。
//   另外内置"剪辑拼接成片"：为素材填起止时间，流拷贝无损剪辑拼接输出成品。
//
// 输出命名：<当天日期>_<游戏名>_视频素材.mp4（例如 2026-09-01_Palworld_视频素材.mp4）
// 默认保存目录：E:\worddeepseek\videocut\material（网页里可改）
// 默认成品目录：E:\worddeepseek\videocut\product（网页里可改）
//
// 用法：
//   node steam-video-downloader.mjs                        -> 启动本地网页 http://localhost:8898
//   node steam-video-downloader.mjs --test                 -> 网络自检
//
// 脚本会自动以 --use-system-ca 重启自身，以信任 Windows 系统证书库，
// 解决网络中间人导致的 "unable to verify the first certificate" 报错。
// 若仍失败可加 --insecure 跳过校验（不安全）。想关闭自动重启可设 STEAM_NO_RELAUNCH=1。
//
// 代理：脚本默认读取环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY；
//       也可临时加参数 --proxy=http://127.0.0.1:7890（支持 http/https/socks5）。
//
// 可选环境变量：
//   PORT          网页端口（默认 8898）
//   VIDEO_DIR     视频默认保存目录（默认 E:/worddeepseek/videocut/material，网页里也可改）
//   FFMPEG_PATH   ffmpeg 可执行文件路径（默认优先使用工具自带 bin/，其次系统安装）

import { createServer } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// 脚本所在目录（内置 bin/ffmpeg.exe 从这里解析）。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// 部分网络环境下 IPv6 解析失败会在连接层报 "fetch failed"，这里优先用 IPv4。
dns.setDefaultResultOrder('ipv4first');

// --insecure：跳过 TLS 证书校验（不安全，仅在确认网络中间人可信、且 --use-system-ca 仍无效时使用）。
const INSECURE = process.argv.includes('--insecure');
if (INSECURE) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.error('⚠️  已开启 --insecure：跳过 TLS 证书校验（连接不再验证服务器身份，不安全）。');
}

const PORT = Number(process.env.PORT || 8898);
const LANG = process.env.STEAM_LANG || 'schinese';
const CC = process.env.STEAM_CC || 'cn';
// 默认保存目录：素材统一放这里，方便后续合并成片。
const DEFAULT_DIR = process.env.VIDEO_DIR || 'E:/worddeepseek/videocut/material';
// 配音文件默认目录（按 01/02/03… 前缀命名，顺序 = 素材段顺序）。
const DEFAULT_VOICE_DIR = process.env.VOICE_DIR || 'E:/worddeepseek/videocut/voice';
// 配音可接受的音频扩展名。
const VOICE_EXTS = /\.(mp3|wav|m4a|aac|flac|ogg|wma|opus)$/i;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── 小工具 ───────────────────────────────────────────────────────────────────

// 从用户输入里提取 appid：支持完整商店链接、/agecheck/ 链接、以及纯数字。
function extractAppId(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/app\/(\d+)/i);
  if (m) return m[1];
  if (/^\d{1,10}$/.test(s)) return s;
  return null;
}

// 文件名安全化：去掉 Windows 非法字符，空白转下划线。
function sanitizeName(s) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .trim() || '未命名游戏';
}

// 当天日期（本地时间）：yyyy-MM-dd
function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 若目标已存在则加 _2/_3 序号，保证不覆盖。
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const ext = path.extname(p);
  const base = p.slice(0, -ext.length) || p;
  for (let i = 2; i < 100; i++) {
    const c = `${base}_${i}${ext}`;
    if (!fs.existsSync(c)) return c;
  }
  return `${base}_${Date.now()}${ext}`;
}

// 自然排序：把文件名拆成"文本/数字"交替段，数字按数值比（1,2,10 而非 1,10,2）。
function splitNaturalParts(s) {
  return String(s ?? '').toLowerCase().split(/(\d+)/).filter(Boolean).map((seg) => {
    if (/^\d+$/.test(seg)) return { isNum: true, num: Number(seg), text: seg };
    return { isNum: false, num: null, text: seg };
  });
}
function naturalCompare(a, b) {
  const pa = splitNaturalParts(a);
  const pb = splitNaturalParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x.isNum && y.isNum) {
      if (x.num !== y.num) return x.num - y.num;
      continue;
    }
    const c = x.text.localeCompare(y.text, 'zh');
    if (c !== 0) return c;
  }
  return 0;
}

// ── 网络层：支持代理（HTTP/HTTPS/SOCKS5）+ 更清晰的错误 ──────────────────────

// 从命令行 --proxy= 或常见环境变量读取代理地址。
function resolveProxy() {
  const flag = process.argv.find((a) => a.startsWith('--proxy='));
  if (flag) return flag.slice('--proxy='.length).trim();
  return (
    process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy ||
    null
  );
}

// 解析代理地址，识别 http/https/socks5 三种。
function parseProxy(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  const proto = u.protocol.replace(':', '');
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol)) {
    throw new Error(`不支持的代理协议：${u.protocol}（仅支持 http/https/socks5）`);
  }
  const kind = proto.startsWith('socks') ? 'socks5' : proto;
  const port = Number(u.port || (proto === 'https:' ? 443 : proto === 'http:' ? 80 : 1080));
  return {
    kind,
    host: u.hostname,
    port,
    auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : null,
  };
}

// 建立到目标主机的隧道（HTTP CONNECT 或 SOCKS5），返回已就绪的裸 socket。
function openTunnel(proxy, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    if (proxy.kind === 'socks5') {
      const sock = net.connect(proxy.port, proxy.host);
      let stage = 0;
      let buf = Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (stage === 0) {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) { sock.destroy(); return reject(new Error('SOCKS5 代理需要认证，暂不支持带密码的 SOCKS5')); }
          buf = buf.subarray(2);
          stage = 1;
          const hostBuf = Buffer.from(targetHost, 'utf8');
          sock.write(Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ]));
        } else if (stage === 1) {
          if (buf.length < 4) return;
          const rep = buf[1];
          const atyp = buf[3];
          let headerLen = 4;
          if (atyp === 0x01) headerLen = 10;
          else if (atyp === 0x04) headerLen = 22;
          else if (atyp === 0x03) headerLen = 5 + buf[4];
          else { sock.destroy(); return reject(new Error('SOCKS5 响应异常')); }
          if (buf.length < headerLen) return;
          if (rep !== 0x00) { sock.destroy(); return reject(new Error(`SOCKS5 连接失败（响应码 ${rep}）`)); }
          sock.off('data', onData);
          resolve(sock);
        }
      };
      sock.on('data', onData);
      sock.once('error', reject);
      sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    } else {
      const raw = proxy.kind === 'https'
        ? tls.connect({ host: proxy.host, port: proxy.port, servername: proxy.host })
        : net.connect(proxy.port, proxy.host);
      const sendConnect = () => {
        const authLine = proxy.auth
          ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n`
          : '';
        raw.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authLine}\r\n`);
      };
      if (proxy.kind === 'https') raw.once('secureConnect', sendConnect);
      else raw.once('connect', sendConnect);
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString('latin1');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const statusLine = (buf.slice(0, idx).split('\r\n')[0] || '').trim();
        const m = / (\d{3})(?: |$)/.exec(statusLine);
        if (!m || m[1] !== '200') {
          raw.destroy();
          return reject(new Error(`代理 CONNECT 失败：${statusLine}`));
        }
        raw.off('data', onData);
        resolve(raw);
      };
      raw.on('data', onData);
      raw.once('error', reject);
    }
  });
}

// 通过隧道为 HTTPS 目标建立一个 https.Agent。
function makeProxyAgent(proxy) {
  return new https.Agent({
    keepAlive: true,
    createConnection(options, cb) {
      openTunnel(proxy, options.host, options.port || 443)
        .then((tunnel) => {
          const tlsSock = tls.connect({ socket: tunnel, servername: options.host });
          tlsSock.once('secureConnect', () => cb(null, tlsSock));
          tlsSock.once('error', cb);
        })
        .catch(cb);
    },
  });
}

// 通用 HTTPS 请求：支持 GET/POST、JSON body、自定义头、代理、超时、二进制响应。
function requestHttps(urlStr, { method = 'GET', headers = {}, body, proxy, timeoutMs = 30000, binary = false } = {}) {
  const target = new URL(urlStr);
  const allHeaders = { 'User-Agent': UA, ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (typeof body !== 'string') allHeaders['Content-Type'] = 'application/json';
    allHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const opts = { method, headers: allHeaders };
    if (proxy) opts.agent = makeProxyAgent(proxy);
    const req = https.request(target, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: binary ? buf : buf.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒）`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// 把底层错误描述得更清楚（区分 DNS / 连接 / 超时 / TLS）。
function describeError(e) {
  const cause = e?.cause?.message || e?.cause?.code || '';
  const msg = e?.message || String(e);
  const text = cause && cause !== msg ? `${msg}（原因：${cause}）` : msg;
  if (/certificate|unable to verify|self[- ]signed|CERT_/i.test(text)) {
    return `${text} —— 这是证书校验失败，先用 node --use-system-ca 运行；若仍失败再加 --insecure`;
  }
  return text;
}

// 通用 HTTP GET（自动跟随重定向、支持代理、可选二进制），返回 { status, body:Buffer, finalUrl }。
// 说明：Steam 视频 CDN 对 .NET 的 TLS 栈不兼容（N_m3u8DL-CLI 直连失败），
//       所以下载分片一律走 Node（系统证书 + 跟随重定向）。
function fetchHttp(urlStr, { binary = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, redirects) => {
      let target;
      try { target = new URL(u); } catch (e) { return reject(new Error(`无效地址：${e.message}`)); }
      const mod = target.protocol === 'http:' ? http : https;
      const opts = { headers: { 'User-Agent': UA, Accept: '*/*' } };
      const proxyRaw = resolveProxy();
      const proxy = proxyRaw ? parseProxy(proxyRaw) : null;
      if (proxy) opts.agent = makeProxyAgent(proxy);
      const req = mod.get(target, opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error('重定向次数过多'));
          return go(new URL(res.headers.location, target).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks),
          finalUrl: res.url || u,
        }));
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`连接超时（${Math.round(timeoutMs / 1000)} 秒）`)));
      req.end();
    };
    go(urlStr, 0);
  });
}

// GET 文本（自动跟随重定向）。
async function fetchText(urlStr, opts = {}) {
  const r = await fetchHttp(urlStr, opts);
  return { text: r.body.toString('utf8'), finalUrl: r.finalUrl };
}

// 调用 Steam appdetails 接口。
async function fetchApp(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${LANG}&cc=${CC}`;
  const proxyRaw = resolveProxy();
  const proxy = proxyRaw ? parseProxy(proxyRaw) : null;
  const res = await requestHttps(url, { proxy });
  if (res.status !== 200) {
    const err = new Error(`Steam API HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error('Steam 返回的内容不是合法 JSON（可能是被代理/网络劫持的页面）');
  }
  const entry = json?.[appid];
  if (!entry || entry.success !== true) return null;
  return entry.data;
}

// 从一部电影里挑视频源。返回 { kind, url, label }：
//   kind = 'direct' 旧接口的 mp4/webm 直链（走内置下载）
//   kind = 'hls'    HLS 流（走 N_m3u8DL-CLI）
//   kind = 'dash'   DASH 流（走 N_m3u8DL-CLI，尽力支持）
function pickSource(movie, quality) {
  const m4 = (movie && typeof movie.mp4 === 'object' && movie.mp4) || {};
  const wb = (movie && typeof movie.webm === 'object' && movie.webm) || {};
  // 1) 旧接口直链
  const dkeys = quality === '480' ? ['480', 'sd', 'max', 'hd'] : ['max', 'hd', 'sd', '480'];
  for (const k of dkeys) {
    if (m4[k]) return { kind: 'direct', url: m4[k], label: `MP4 ${k === 'max' ? '最高' : k}` };
  }
  for (const k of dkeys) {
    if (wb[k]) return { kind: 'direct', url: wb[k], label: `WebM ${k === 'max' ? '最高' : k}` };
  }
  // 2) 新接口流媒体（优先 HLS H.264，兼容性最好）
  if (movie?.hls_h264) return { kind: 'hls', url: movie.hls_h264, label: 'HLS H.264' };
  if (movie?.dash_h264) return { kind: 'dash', url: movie.dash_h264, label: 'DASH H.264' };
  if (movie?.dash_av1) return { kind: 'dash', url: movie.dash_av1, label: 'DASH AV1' };
  return null;
}

// ── 直链下载（旧接口 mp4/webm 用）────────────────────────────────────────────

// 流式下载文件（自动跟随重定向、支持取消、回报进度）。
function downloadFile(urlStr, destPath, { signal, onProgress, timeoutMs = 1800000 } = {}) {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const part = destPath + '.part';
    const cleanupPart = () => { try { fs.rmSync(part, { force: true }); } catch { /* 忽略 */ } };

    const go = (u) => {
      if (signal && signal.aborted) return reject(new Error('已取消'));
      let target;
      try { target = new URL(u); } catch (e) { return reject(new Error(`无效的下载地址：${e.message}`)); }

      const opts = { method: 'GET', headers: { 'User-Agent': UA, Accept: '*/*' } };
      const proxyRaw = resolveProxy();
      const proxy = proxyRaw ? parseProxy(proxyRaw) : null;
      if (proxy) opts.agent = makeProxyAgent(proxy);

      const req = https.request(target, opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (++redirects > 5) { req.destroy(); return reject(new Error('重定向次数过多')); }
          return go(new URL(res.headers.location, target).toString());
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = parseInt(String(res.headers['content-length'] || '0'), 10) || 0;
        let received = 0;
        const out = fs.createWriteStream(part);
        const onAbort = () => { req.destroy(new Error('已取消')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        out.on('error', (e) => { req.destroy(); reject(e); });
        res.on('data', (c) => {
          received += c.length;
          if (onProgress) onProgress(received, total);
        });
        res.pipe(out);
        out.on('finish', () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          try {
            if (fs.existsSync(destPath)) fs.rmSync(destPath, { force: true });
            fs.renameSync(part, destPath);
          } catch (e) {
            cleanupPart();
            return reject(new Error(`保存文件失败：${e.message}`));
          }
          resolve({ bytes: received, total });
        });
      });
      req.on('error', (e) => {
        cleanupPart();
        reject(e);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('下载超时（30 分钟）')));
      req.end();
    };
    go(urlStr);
  });
}

// ── HLS 混合下载：Node 拉分片 -> 本地清单 -> ffmpeg 合并 ─────────────────────
// 原因：Steam 视频 CDN 对 .NET TLS 栈不兼容（.NET 工具直连报"接收时发生错误"），
//       而 Node（--use-system-ca）可正常访问。故下载阶段用 Node，合并阶段用 ffmpeg
//       （工具自带 bin/，或自动探测系统安装）。全程无需外部 m3u8 解析器。

// 相对引用解析。
function resolveRef(base, ref) {
  return new URL(ref, base).toString();
}

// 解析 m3u8：返回 { segs:[{uri}], map:{uri}|null, key:{uri}|null }。
function parseM3u8(text) {
  const lines = String(text).split(/\r?\n/);
  const segs = [];
  let map = null;
  let key = null;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MAP')) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m) map = { uri: m[1] };
    } else if (l.startsWith('#EXT-X-KEY')) {
      const m = /URI="([^"]+)"/.exec(l);
      const method = /METHOD=([^,\s]+)/.exec(l);
      if (m && method && /AES-128/i.test(method[1])) key = { uri: m[1] };
    } else if (l.trim() && !l.startsWith('#')) {
      segs.push({ uri: l.trim() });
    }
  }
  return { segs, map, key };
}

// 把清单里的远程引用改写成本地文件名。
function rewritePlaylist(text, base, localNames) {
  return String(text).split(/\r?\n/).map((l) => {
    if (l.startsWith('#EXT-X-MAP') || l.startsWith('#EXT-X-KEY')) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m) {
        const u = resolveRef(base, m[1]);
        return l.replace(m[1], localNames[u] || m[1]);
      }
      return l;
    }
    if (l.trim() && !l.startsWith('#')) {
      const u = resolveRef(base, l.trim());
      return localNames[u] || l;
    }
    return l;
  }).join('\n');
}

// 混合下载主函数：下载主清单 + 最优变体 + 音轨 + 全部分片到 workDir，
// 改写成本地 video.m3u8 / audio.m3u8 / master.m3u8。
// onProgress(done, total, bytes, secs) 回报进度。
// resolve 返回 { masterPath, totalBytes }。
async function downloadHlsToLocal(masterUrl, quality, workDir, onProgress) {
  fs.mkdirSync(workDir, { recursive: true });
  const master = await fetchText(masterUrl);
  const mLines = master.text.split(/\r?\n/);

  let audioUri = null;
  const variants = [];
  for (let i = 0; i < mLines.length; i++) {
    const l = mLines[i];
    if (l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/i.test(l)) {
      const m = /URI="([^"]+)"/.exec(l);
      if (m) audioUri = m[1];
    } else if (l.startsWith('#EXT-X-STREAM-INF')) {
      const next = (mLines[i + 1] || '').trim();
      if (next && !next.startsWith('#')) {
        const bw = Number((/BANDWIDTH=(\d+)/.exec(l) || [])[1] || 0);
        const res = /RESOLUTION=(\d+)x(\d+)/.exec(l);
        variants.push({ uri: next, bw, width: res ? Number(res[1]) : 0 });
      }
    }
  }

  // 选变体：max = 码率最高；480 = 最接近 854x480（无分辨率信息时按码率估算）。
  let videoUri = null;
  if (variants.length) {
    if (quality === '480') {
      variants.sort((a, b) =>
        Math.abs((a.width || Math.sqrt(a.bw)) - 854) - Math.abs((b.width || Math.sqrt(b.bw)) - 854));
    } else {
      variants.sort((a, b) => b.bw - a.bw);
    }
    videoUri = variants[0].uri;
  }

  // 拉取子清单。
  const vUrl = videoUri ? resolveRef(master.finalUrl || masterUrl, videoUri) : masterUrl;
  const vRes = videoUri ? await fetchText(vUrl) : master;
  const vp = parseM3u8(vRes.text);
  let ap = null;
  let aUrl = null;
  if (audioUri) {
    aUrl = resolveRef(master.finalUrl || masterUrl, audioUri);
    ap = parseM3u8((await fetchText(aUrl)).text);
  }

  // 汇总需要下载的文件。
  const files = [];
  const push = (base, uri) => files.push({ base, uri });
  for (const s of vp.segs) push(vUrl, s.uri);
  if (vp.map) push(vUrl, vp.map.uri);
  if (vp.key) push(vUrl, vp.key.uri);
  if (ap) {
    for (const s of ap.segs) push(aUrl, s.uri);
    if (ap.map) push(aUrl, ap.map.uri);
    if (ap.key) push(aUrl, ap.key.uri);
  }
  const total = files.length;
  if (!total) throw new Error('播放清单里没有找到任何分片');

  // 并发下载。
  const localNames = {};
  let done = 0;
  let totalBytes = 0;
  const t0 = Date.now();
  const indexed = files.map((f, i) => ({ ...f, idx: i }));
  await runPool(indexed, async (f) => {
    const u = resolveRef(f.base, f.uri);
    const r = await fetchHttp(u, { timeoutMs: 120000 });
    // 用 .m4s 扩展名命名，保证 ffmpeg 的 hls 解复用器允许（hls.c 扩展名白名单）。
    const name = `f_${String(f.idx).padStart(4, '0')}.m4s`;
    localNames[u] = name;
    fs.writeFileSync(path.join(workDir, name), r.body);
    totalBytes += r.body.length;
    done += 1;
    if (onProgress) {
      try { onProgress(done, total, totalBytes, (Date.now() - t0) / 1000); } catch { /* ignore */ }
    }
  }, 6);

  // 写本地清单。
  const videoLocal = rewritePlaylist(vRes.text, vUrl, localNames);
  fs.writeFileSync(path.join(workDir, 'video.m3u8'), videoLocal);
  if (ap) {
    const audioLocal = rewritePlaylist((await fetchText(aUrl)).text, aUrl, localNames);
    fs.writeFileSync(path.join(workDir, 'audio.m3u8'), audioLocal);
  }
  const sm = ['#EXTM3U', '#EXT-X-VERSION:7'];
  if (ap) sm.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",AUTOSELECT=YES,DEFAULT=YES,URI="audio.m3u8"');
  sm.push('#EXT-X-STREAM-INF:BANDWIDTH=5800000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=1920x1080' + (ap ? ',AUDIO="audio"' : ''));
  sm.push('video.m3u8');
  const masterLocal = path.join(workDir, 'master.m3u8');
  fs.writeFileSync(masterLocal, sm.join('\n'));

  return { masterPath: masterLocal, totalBytes };
}

// ── 本地 ffmpeg（合并/混流，纯本地文件，不涉及网络 TLS）──────────────────────

// 查找 ffmpeg：内置 bin/ -> 环境变量 -> 系统安装 -> PATH。
function resolveFfmpeg() {
  const candidates = [
    path.join(SCRIPT_DIR, 'bin', 'ffmpeg.exe'), // 工具自带（内置，开箱即用）
    process.env.FFMPEG_PATH,
    'C:/Users/chr/AppData/Local/Programs/ffmpeg/bin/ffmpeg.exe', // 本机系统安装
    'ffmpeg',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (c === 'ffmpeg' || fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

// 运行一个本地命令（不捕获输出，stdout/stderr 丢弃）。
function runLocal(cmd, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    } catch (e) {
      return reject(new Error(`启动失败：${e.message}`));
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`启动失败：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`退出码 ${code}`));
    });
  });
}

// 直接读本地 master.m3u8 合并（视频+音频一组出片）。
async function mergeWithFfmpeg(masterPath, dest) {
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('未找到 ffmpeg，无法合并');
  await runLocal(ff, ['-y', '-allowed_extensions', 'ALL', '-i', masterPath, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', dest]);
}

// ── 任务（Job）管理 ──────────────────────────────────────────────────────────

const jobs = new Map(); // jobId -> job

function createJob({ links, dir, skipExisting, quality }) {
  const items = [];
  const seen = new Set();
  for (const raw of links) {
    const line = String(raw ?? '').trim();
    if (!line) continue;
    const appid = extractAppId(line);
    if (!appid) {
      items.push({ link: line, appid: null, name: '', state: '无效链接', percent: 0, size: 0, speed: '', path: '', error: '无法识别 appid（需要商店链接或纯数字）' });
      continue;
    }
    if (seen.has(appid)) continue; // 同一游戏去重
    seen.add(appid);
    items.push({
      link: line, appid, name: '', state: '等待中',
      percent: 0, size: 0, speed: '', path: '', error: '',
      videoUrl: '', videoLabel: '', videoKind: '', log: [],
    });
  }
  return {
    id: randomUUID(),
    dir,
    skipExisting,
    quality,
    status: 'running', // running / done / canceled / error
    error: '',
    canceled: false,
    aborts: new Set(),
    childProcs: new Set(),
    items,
    startedAt: Date.now(),
    finishedAt: null,
    listeners: new Set(),
    lastEmit: 0,
  };
}

// 序列化视图（去掉 listeners 等运行时字段）。
function jobView(job) {
  return {
    id: job.id,
    dir: job.dir,
    skipExisting: job.skipExisting,
    quality: job.quality,
    status: job.status,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    items: job.items.map((it) => ({ ...it, log: (it.log || []).slice(-6) })),
  };
}

// 推送快照给所有 SSE 客户端；普通进度节流 250ms，状态变化强制推。
function emitJob(job, force) {
  const now = Date.now();
  if (!force && now - job.lastEmit < 250) return;
  job.lastEmit = now;
  const data = JSON.stringify({ type: 'snapshot', job: jobView(job) });
  for (const res of job.listeners) {
    try { res.write(`data: ${data}\n\n`); } catch { /* 客户端可能已断开 */ }
  }
}

// 简单的并发池：并发跑 items 里的每一项，每个项交给 worker。
async function runPool(items, worker, concurrency) {
  if (!items.length) return;
  let idx = 0;
  const runners = [];
  const n = Math.max(1, Math.min(concurrency, items.length));
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      while (idx < items.length) {
        const cur = idx++;
        await worker(items[cur]);
      }
    })());
  }
  await Promise.all(runners);
}

// 执行任务：阶段一拿游戏信息，阶段二下载视频。
async function runJob(job) {
  try {
    const pending = job.items.filter((it) => it.appid);

    // 阶段一：并发 3 获取游戏信息（名字 + 第一个视频地址）。
    await runPool(pending, async (it) => {
      if (job.canceled) { it.state = '已取消'; emitJob(job, true); return; }
      it.state = '获取游戏信息';
      emitJob(job, true);
      try {
        const data = await fetchApp(it.appid);
        if (job.canceled) { it.state = '已取消'; emitJob(job, true); return; }
        if (!data) {
          it.state = '失败';
          it.error = 'appdetails 未返回数据（可能不存在、地区受限或需年龄验证）';
          emitJob(job, true);
          return;
        }
        it.name = data.name || `App ${it.appid}`;
        const movies = Array.isArray(data.movies) ? data.movies : [];
        const movie = movies[0]; // 只取第一个视频
        const src = movie ? pickSource(movie, job.quality) : null;
        if (!src) {
          it.state = '无视频';
          it.error = '该游戏没有宣传视频';
          emitJob(job, true);
          return;
        }
        it.videoUrl = src.url;
        it.videoLabel = src.label;
        it.videoKind = src.kind;
        it.state = '待下载';
        emitJob(job, true);
      } catch (e) {
        it.state = '失败';
        it.error = `获取信息失败：${describeError(e)}`;
        emitJob(job, true);
      }
    }, 3);

    // 阶段二：逐一下载（N_m3u8DL-CLI 本身多线程，串行执行避免网络挤占）。
    const todo = pending.filter((it) => it.videoUrl);
    await runPool(todo, async (it) => {
      if (job.canceled) { it.state = '已取消'; emitJob(job, true); return; }
      it.log = [];
      const baseName = `${todayStr()}_${sanitizeName(it.name)}_视频素材`;
      const ext = it.videoKind === 'direct' ? (/\.webm($|\?)/i.test(it.videoUrl) ? 'webm' : 'mp4') : 'mp4';
      const expected = path.join(job.dir, `${baseName}.${ext}`);

      if (job.skipExisting && fs.existsSync(expected)) {
        const st = fs.statSync(expected);
        it.state = '已存在';
        it.path = expected;
        it.size = st.size;
        it.percent = 100;
        emitJob(job, true);
        return;
      }

      it.state = '下载中';
      it.percent = 0;
      it.speed = '';
      it.size = 0;
      it.path = '';
      emitJob(job, true);

      const ac = new AbortController();
      job.aborts.add(ac);
      const t0 = Date.now();
      const onProgressTick = (got, total) => {
        it.percent = total ? Math.round((got / total) * 100) : 0;
        const secs = Math.max(0.1, (Date.now() - t0) / 1000);
        it.speed = `${formatSize(got / secs)}/s`;
        it.size = total || got;
        emitJob(job, false);
      };

      try {
        let finalPath = '';
        if (it.videoKind === 'direct') {
          // 旧接口直链：Node 直接下载。
          const dest = uniquePath(expected);
          await downloadFile(it.videoUrl, dest, { signal: ac.signal, onProgress: onProgressTick });
          finalPath = dest;
        } else if (it.videoKind === 'dash') {
          it.state = '失败';
          it.error = '该游戏仅提供 DASH 流（.mpd），当前版本暂不支持自动下载';
          emitJob(job, true);
          return;
        } else {
          // HLS：Node 下载分片 -> 本地清单 -> 内置 ffmpeg 合并（无需外部解析器）。
          const tmpDir = path.join(SCRIPT_DIR, `.tmp_hls_${it.appid}_${Date.now()}_${randomUUID().slice(0, 6)}`);
          const masterLocal = path.join(tmpDir, 'master.m3u8');
          try {
            await downloadHlsToLocal(it.videoUrl, job.quality, tmpDir, (done, total, bytes, secs) => {
              it.percent = total ? Math.round((done / total) * 100) : 0;
              it.speed = `${formatSize(bytes / Math.max(0.1, secs))}/s`;
              it.size = bytes;
              it.log = [`正在下载分片 ${done}/${total}（视频+音轨）`];
              emitJob(job, false);
            });
            it.percent = 90;
            it.log = ['分片下载完成，正在合并成 mp4…'];
            emitJob(job, false);
            finalPath = uniquePath(expected);
            await mergeWithFfmpeg(masterLocal, finalPath);
          } finally {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
        const st = fs.statSync(finalPath);
        it.state = '完成';
        it.percent = 100;
        it.speed = '';
        it.size = st.size;
        it.path = finalPath;
        emitJob(job, true);
      } catch (e) {
        if (ac.signal.aborted) {
          it.state = '已取消';
          it.error = '';
        } else {
          it.state = '失败';
          it.error = `${it.videoKind === 'direct' ? '下载' : 'N_m3u8DL-CLI'}失败：${describeError(e)}`;
        }
        emitJob(job, true);
      } finally {
        job.aborts.delete(ac);
      }
    }, 1);

    job.status = job.canceled ? 'canceled' : 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e.message;
  }
  job.finishedAt = Date.now();
  emitJob(job, true);
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  for (const ac of job.aborts) ac.abort();
  for (const it of job.items) {
    if (it.state === '等待中' || it.state === '待下载') it.state = '已取消';
  }
  emitJob(job, true);
  return true;
}

// ── 文件工具 ─────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function listFiles(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => !f.endsWith('.part'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs, path: path.join(dir, f) };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    // 目录不存在或不可读时返回空列表
  }
  return files;
}

// ── 剪辑拼接（本地 ffmpeg：cut -> 统一 timescale -> concat 流拷贝）─────────────

// 解析时间字符串为秒：支持 "90" / "1.5" / "1:30" / "1:30.5" / "01:02:03.4"；空返回 null。
function parseTime(str) {
  const s = String(str ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s); // mm:ss 或 hh:mm:ss
  if (m) {
    const h = m[1] ? Number(m[1]) : 0;
    const min = Number(m[2]);
    const sec = Number(m[3]);
    if (min >= 60 || sec >= 60) return null;
    return h * 3600 + min * 60 + sec;
  }
  const m2 = /^(\d+):(\d+(?:\.\d+)?)$/.exec(s); // m:ss
  if (m2) {
    const min = Number(m2[1]);
    const sec = Number(m2[2]);
    if (sec >= 60) return null;
    return min * 60 + sec;
  }
  return null;
}

// 把本地路径转成 ffmpeg concat 列表可用的形式（正斜杠 + 单引号转义）。
function escapeConcatPath(p) {
  const fwd = String(p).replace(/\\/g, '/');
  return `'${fwd.replace(/'/g, `'\\''`)}'`;
}

// 从素材文件名解析游戏名：去掉 "日期_" 前缀与 "_视频素材" 后缀。
// 例：2026-09-01_Palworld_幻兽帕鲁_视频素材.mp4 -> Palworld_幻兽帕鲁
function parseGameNameFromFile(filename) {
  let n = String(filename ?? '').replace(/\.[^.]+$/, '');
  n = n.replace(/^\d{4}-\d{2}-\d{2}_?/, '');
  n = n.replace(/_视频素材$/, '').replace(/_素材$/, '');
  return n || path.basename(filename).replace(/\.[^.]+$/, '') || '素材';
}

// 剪辑拼接主流程（流拷贝、无损）：
//   materials: [{ name, path, start, end }]（按数组顺序）
//   outDir: 成品目录；outName: 成品名（不含扩展名，缺省自动 "日期_名称1_名称2…"）
// 返回 { output, size, duration }。
async function composeVideos(materials, outDir, outName) {
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('未找到 ffmpeg，无法剪辑拼接');
  const list = [];
  for (const m of materials) {
    const p = String(m.path || '').trim();
    if (!p) throw new Error('存在未填写文件路径的素材项');
    if (!fs.existsSync(p)) throw new Error(`素材文件不存在：${p}`);
    const start = parseTime(m.start);
    const end = parseTime(m.end);
    if (start !== null && end !== null && end <= start) throw new Error(`时间段无效（结束需晚于开始）：${m.name || p}`);
    list.push({ name: String(m.name || '').trim() || parseGameNameFromFile(path.basename(p)), path: p, start, end });
  }

  // 成品文件名
  const dateStr = todayStr();
  const baseName = (outName && String(outName).trim())
    ? String(outName).trim()
    : `${dateStr}_${list.map((x) => sanitizeName(x.name)).join('_')}`;
  const dest = uniquePath(path.join(outDir, `${sanitizeName(baseName)}.mp4`));

  // 临时目录：放工具目录（已 .gitignore），结束后删除；产物写 outDir
  const tmpDir = path.join(SCRIPT_DIR, `.tmp_compose_${Date.now()}_${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const normClips = [];
  try {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      const clip = path.join(tmpDir, `clip${i + 1}.mp4`);
      const norm = path.join(tmpDir, `norm${i + 1}.mp4`);
      const args = ['-y', '-loglevel', 'error'];
      if (it.start !== null) { args.push('-ss', String(it.start)); }
      args.push('-i', it.path);
      if (it.start !== null && it.end !== null) args.push('-t', String(it.end - it.start));
      else if (it.end !== null) args.push('-to', String(it.end));
      args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', clip);
      await runLocal(ff, args, { timeoutMs: 300000 });
      if (!fs.existsSync(clip)) throw new Error(`剪辑失败（未生成片段）：${it.name}`);
      // 统一视频 timescale（不同帧率的流直接 concat 会导致时间戳错乱）
      await runLocal(ff, ['-y', '-loglevel', 'error', '-i', clip, '-c', 'copy', '-video_track_timescale', '15360', norm], { timeoutMs: 300000 });
      normClips.push(norm);
    }
    const listFile = path.join(tmpDir, 'list.txt');
    const lines = normClips.map((c) => `file ${escapeConcatPath(c)}`);
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8'); // UTF-8 无 BOM，ffmpeg concat 才能识别
    await runLocal(ff, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', dest], { timeoutMs: 600000 });
    if (!fs.existsSync(dest)) throw new Error('拼接失败（未生成成品文件）');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const st = fs.statSync(dest);
  return { output: dest, size: st.size };
}

// ── 配音上传（真人配音，01/02/03… 前缀，顺序 = 素材段顺序）────────────────────

// GET /api/voice/list?dir=... ：列出配音目录音频，按文件名自然排序。
function handleVoiceList(urlObj, res) {
  const dir = urlObj.searchParams.get('dir') || DEFAULT_VOICE_DIR;
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => VOICE_EXTS.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, size: st.size, mtime: st.mtimeMs, path: path.join(dir, f) };
      })
      .sort((a, b) => naturalCompare(a.name, b.name));
  } catch {
    // 目录不存在或不可读时返回空列表
  }
  return json(res, 200, { dir, files });
}

// POST /api/voice/upload?name=xx.mp3&dir=... ：上传单个音频（body 为文件二进制，流式落盘，同名覆盖）。
function handleVoiceUpload(req, res, urlObj) {
  const name = String(urlObj.searchParams.get('name') || '').trim();
  const dir = urlObj.searchParams.get('dir') || DEFAULT_VOICE_DIR;
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return json(res, 400, { error: '文件名无效' });
  }
  if (!VOICE_EXTS.test(name)) {
    return json(res, 400, { error: `不支持的音频格式，支持：mp3/wav/m4a/aac/flac/ogg/wma/opus` });
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return json(res, 400, { error: `无法创建配音目录：${e.message}` });
  }
  const target = path.join(dir, name);
  const ws = fs.createWriteStream(target);
  req.pipe(ws);
  ws.on('finish', () => {
    try {
      const st = fs.statSync(target);
      return json(res, 200, { ok: true, name, size: st.size });
    } catch (e) {
      return json(res, 500, { error: `保存失败：${e.message}` });
    }
  });
  ws.on('error', (e) => {
    try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
    return json(res, 500, { error: `写入失败：${e.message}` });
  });
  req.on('aborted', () => {
    try { ws.destroy(); fs.rmSync(target, { force: true }); } catch { /* ignore */ }
  });
}

// GET /api/voice/delete?name=xx.mp3&dir=... ：删除一个配音文件。
function handleVoiceDelete(urlObj, res) {
  const dir = urlObj.searchParams.get('dir') || DEFAULT_VOICE_DIR;
  const name = String(urlObj.searchParams.get('name') || '').trim();
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    return json(res, 400, { error: '文件名无效' });
  }
  const target = path.join(dir, name);
  if (!fs.existsSync(target)) return json(res, 404, { error: '文件不存在' });
  try {
    fs.rmSync(target, { force: true });
    return json(res, 200, { ok: true });
  } catch (e) {
    return json(res, 500, { error: `删除失败：${e.message}` });
  }
}

// ── 文案 → 字幕（B1：whisper 时间轴 + 文案矫正对齐）───────────────────────────

// 定位 sherpa-onnx 引擎与 whisper 模型（A1 部署在项目内 sherpa-onnx/ 目录）。
function resolveSherpaOnnx() {
  const base = path.join(SCRIPT_DIR, 'sherpa-onnx');
  let exe = null;
  try {
    const rt = path.join(base, 'runtime');
    for (const d of fs.readdirSync(rt)) {
      const p = path.join(rt, d, 'bin', 'sherpa-onnx-offline.exe');
      if (fs.existsSync(p)) { exe = p; break; }
    }
  } catch { /* ignore */ }
  const wm = path.join(base, 'models', 'whisper-small-int8');
  const enc = path.join(wm, 'small-encoder.int8.onnx');
  const dec = path.join(wm, 'small-decoder.int8.onnx');
  const tok = path.join(wm, 'small-tokens.txt');
  return {
    exe,
    encoder: enc, decoder: dec, tokens: tok,
    available: !!(exe && fs.existsSync(enc) && fs.existsSync(dec) && fs.existsSync(tok)),
  };
}

// 简繁映射（OpenCC STCharacters.txt，随仓库 lib/ 分发），繁体→简体。
let SIMP_MAP = null;
function loadSimpMap() {
  if (SIMP_MAP) return SIMP_MAP;
  SIMP_MAP = new Map();
  try {
    const text = fs.readFileSync(path.join(SCRIPT_DIR, 'lib', 'STCharacters.txt'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const cols = line.split(/\s+/);
      if (cols.length >= 2 && !cols[1].includes('→')) SIMP_MAP.set(cols[0], cols[1]);
    }
  } catch { /* 缺表时简繁转换不可用，仅影响繁体匹配 */ }
  return SIMP_MAP;
}
// 文本转简体（whisper 输出常为繁体）。
function simplifyText(text) {
  const map = loadSimpMap();
  if (!map.size) return String(text);
  let out = '';
  for (const ch of String(text)) out += map.get(ch) || ch;
  return out;
}
// 归一化：去空白与标点，用于文本比对。
function normText(text) {
  return simplifyText(text)
    .replace(/[\s，。！？、；：""''（）《》【】…—·,.!?;:()<>'"-]/g, '')
    .toLowerCase();
}

// 文案分句：按换行 / 句末标点切。
function splitScriptSentences(script) {
  const out = [];
  for (const line of String(script ?? '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // 按句末标点拆（保留标点），也处理无标点的长行
    const parts = t.split(/(?<=[。！？!?；;])/);
    for (const s of parts) {
      const v = s.trim();
      if (v) out.push(v);
    }
  }
  return out;
}

// srt 时间格式 HH:MM:SS,mmm
function toSrtTime(sec) {
  sec = Math.max(0, Number(sec) || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  const p = (n, l) => String(n).padStart(l, '0');
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(ms, 3)}`;
}

// 运行 whisper 识别（sherpa-onnx），结果通过重定向 stdout 到文件获得（沙箱无法用管道捕获）。
// 输入任意音频路径（内部会先转 wav 由调用方负责）；返回 segments: [{start,end,text}]（text 已转简体）。
async function runWhisperAsr(wavPath) {
  const so = resolveSherpaOnnx();
  if (!so.available) throw new Error('未找到 sherpa-onnx 语音识别引擎（需项目内 sherpa-onnx/models/whisper-small-int8）');
  const outFile = path.join(SCRIPT_DIR, `.tmp_asr_${Date.now()}_${randomUUID().slice(0, 8)}.json`);
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  const outFd = fs.openSync(outFile, 'w');
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(so.exe, [
        `--whisper-encoder=${so.encoder}`,
        `--whisper-decoder=${so.decoder}`,
        `--tokens=${so.tokens}`,
        '--whisper-language=zh',
        '--whisper-task=transcribe',
        '--whisper-enable-segment-timestamps',
        '--num-threads=6',
        wavPath,
      ], { stdio: ['ignore', outFd, outFd], windowsHide: true });
    } catch (e) {
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      return reject(new Error(`无法启动 sherpa-onnx：${e.message}`));
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 600000);
    child.on('error', (e) => { clearTimeout(timer); try { fs.closeSync(outFd); } catch { /* ignore */ } reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(outFd); } catch { /* ignore */ }
      resolve(code);
    });
  });
  let content = '';
  try { content = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
  const segments = [];
  for (const line of content.split(/\r?\n/)) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const j = JSON.parse(l);
      const ts = j.segment_timestamps || [];
      const du = j.segment_durations || [];
      const texts = j.segment_texts || [];
      for (let i = 0; i < texts.length; i++) {
        segments.push({
          start: Number(ts[i]) || 0,
          end: (Number(ts[i]) || 0) + (Number(du[i]) || 0),
          text: simplifyText(String(texts[i])).trim(),
        });
      }
    } catch { /* ignore */ }
  }
  try { fs.rmSync(outFile, { force: true }); } catch { /* ignore */ }
  if (!segments.length) throw new Error('语音识别没有产出结果（音频可能不是清晰人声）');
  return segments;
}

// 把文案句子按顺序映射到 whisper 时间轴上（匀速朗读假设 + 就近吸附段边界）。
// 返回 [{ text, start, end }]。
function alignScriptToSegments(sentences, segments) {
  const totalDur = segments.length ? segments[segments.length - 1].end : 0;
  const norm = (s) => normText(s).length || 1;
  const lens = sentences.map(norm);
  const totalLen = lens.reduce((a, b) => a + b, 0);
  const out = [];
  let segIdx = 0;
  let lastEnd = 0;
  for (let i = 0; i < sentences.length; i++) {
    const expDur = (lens[i] / totalLen) * totalDur; // 期望时长（匀速假设）
    const start = segIdx < segments.length ? segments[segIdx].start : lastEnd;
    let acc = 0;
    let guard = 0;
    // 分配 whisper 段给本句：累计段时长达到期望即停（避免抢下句的段）
    while (segIdx < segments.length && acc < expDur * 0.85 && guard++ < segments.length) {
      const segStart = Math.max(segments[segIdx].start, start);
      acc += Math.max(0, segments[segIdx].end - segStart);
      segIdx++;
    }
    let end = segIdx < segments.length ? segments[segIdx].start : (segments.length ? segments[segments.length - 1].end : lastEnd);
    end = Math.max(end, start + 0.3);
    out.push({ text: sentences[i], start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
    lastEnd = end;
  }
  return out;
}

// 生成 srt 文本。
function buildSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${toSrtTime(c.start)} --> ${toSrtTime(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

// POST /api/subtitle/generate ：{ voiceFile, script, voiceDir? } → 生成 <配音名>.srt
async function handleSubtitleGenerate(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const voiceName = String(payload.voiceFile || '').trim();
  const script = String(payload.script || '').trim();
  const dir = String(payload.voiceDir || '').trim() || DEFAULT_VOICE_DIR;
  // srt 输出目录：可用 outDir 自定义，缺省与配音同目录。
  const outDir = String(payload.outDir || '').trim() || dir;
  if (!voiceName || voiceName.includes('..') || voiceName.includes('/') || voiceName.includes('\\')) {
    return json(res, 400, { error: '请选择配音文件' });
  }
  if (!script) return json(res, 400, { error: '请粘贴文案内容' });
  const voicePath = path.join(dir, voiceName);
  if (!fs.existsSync(voicePath)) return json(res, 404, { error: `配音文件不存在：${voiceName}` });
  const ff = resolveFfmpeg();
  if (!ff) return json(res, 500, { error: '未找到 ffmpeg' });
  const sentences = splitScriptSentences(script);
  if (!sentences.length) return json(res, 400, { error: '文案为空或无法分句' });
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    return json(res, 400, { error: `无法创建字幕输出目录：${e.message}` });
  }

  const tmpDir = path.join(SCRIPT_DIR, `.tmp_sub_${Date.now()}_${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    // 1) 转 16k 单声道 wav（sherpa-onnx 输入）
    const wav = path.join(tmpDir, 'voice.wav');
    await runLocal(ff, ['-y', '-loglevel', 'error', '-i', voicePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { timeoutMs: 120000 });
    // 2) whisper 识别（带句级时间戳）
    const segments = await runWhisperAsr(wav);
    // 3) 文案句子 ↔ 时间轴对齐
    const cues = alignScriptToSegments(sentences, segments);
    // 4) 生成并保存 srt（与配音同名，存到 outDir）
    const srtText = buildSrt(cues);
    const srtFile = path.join(outDir, voiceName.replace(/\.[^.]+$/, '') + '.srt');
    fs.writeFileSync(srtFile, srtText, 'utf8');
    return json(res, 200, { ok: true, srtFile, srt: srtText, cues });
  } catch (e) {
    return json(res, 502, { error: `字幕生成失败：${e.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Excel 读取（A3：零依赖 .xlsx 解析 + 上传预览）────────────────────────────

// Excel 上传默认目录。
const DEFAULT_EXCEL_DIR = process.env.EXCEL_DIR || 'E:/worddeepseek/videocut/excel';

// 解压 zip（只读 local headers，标准 xlsx 足够）。返回 { entryName: Buffer }
function unzipEntries(buf) {
  const entries = {};
  let i = 0;
  while (i + 30 <= buf.length) {
    if (buf.readUInt32LE(i) !== 0x04034b50) break; // 到 central directory 即停
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.subarray(i + 30, i + 30 + nameLen).toString('utf8');
    const dataStart = i + 30 + nameLen + extraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (!name.endsWith('/')) {
      entries[name] = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    i = dataStart + compSize;
  }
  return entries;
}

// 解析 xlsx：返回 [{ name, path }]（sheet 名与对应 worksheet 文件路径）。
function listXlsxSheets(buf) {
  const zip = unzipEntries(buf);
  const wb = (zip['xl/workbook.xml'] || Buffer.alloc(0)).toString('utf8');
  const rels = (zip['xl/_rels/workbook.xml.rels'] || Buffer.alloc(0)).toString('utf8');
  const relMap = {};
  const relRe = /Id="(rId\d+)"[^>]*Target="([^"]*)"/g;
  let m;
  while ((m = relRe.exec(rels))) relMap[m[1]] = m[2];
  const sheets = [];
  const sheetRe = /<sheet[^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"[^>]*\/?>/g;
  while ((m = sheetRe.exec(wb))) {
    const target = relMap[m[2]] || '';
    if (target) sheets.push({ name: m[1], path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\//, '')}`.replace(/^xl\/xl\//, 'xl/') });
  }
  // 简化路径归一
  return sheets.map((s) => ({ ...s, path: s.path.replace(/^xl\/xl\//, 'xl/') }));
}

// 读取某个 sheet，返回二维数组（表头行 + 数据行），单元格保留原始文本。
function readXlsxSheet(buf, sheetPath) {
  const zip = unzipEntries(buf);
  const ssXml = (zip['xl/sharedStrings.xml'] || Buffer.alloc(0)).toString('utf8');
  const ss = [];
  const siRe = /<si>(.*?)<\/si>/gs;
  let mm;
  while ((mm = siRe.exec(ssXml))) {
    let txt = '';
    const p = /<t[^>]*>(.*?)<\/t>/gs;
    let tm;
    while ((tm = p.exec(mm[1]))) txt += tm[1];
    ss.push(txt);
  }
  const xml = (zip[sheetPath] || Buffer.alloc(0)).toString('utf8');
  const rowRe = /<row[^>]*>(.*?)<\/row>/gs; // 捕获组(.*?) = 行内 XML
  const grid = [];
  const attrsOf = (s) => {
    const o = {};
    const re = /([\w:]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(s))) o[m[1]] = m[2];
    return o;
  };
  while ((mm = rowRe.exec(xml))) {
    const rowCells = [];
    const cellRe = /<c\b[^>]*>.*?<\/c>|<c\b[^>]*\/>/gs;
    let cm;
    while ((cm = cellRe.exec(mm[1]))) {
      const tag = cm[0];
      const head = tag.slice(0, tag.indexOf('>'));
      const a = attrsOf(head);
      if (!a.r) continue;
      const colMatch = /^([A-Z]+)/.exec(a.r);
      if (!colMatch) continue;
      const vM = /<v>([^<]*)<\/v>/.exec(tag);
      const iM = /<is>[\s\S]*?<t[^>]*>(.*?)<\/t>[\s\S]*?<\/is>/.exec(tag);
      let val = '';
      if (a.t === 's' && vM) val = ss[Number(vM[1])] ?? '';
      else if (a.t === 'inlineStr' && iM) val = iM[1];
      else if (a.t === 'str' && vM) val = vM[1];
      else if (vM) val = vM[1];
      rowCells.push({ col: colMatch[1], val });
    }
    rowCells.sort((a, b) => a.col.length !== b.col.length ? a.col.length - b.col.length : (a.col < b.col ? -1 : 1));
    const row = rowCells.map((c) => c.val.trim());
    grid.push(row);
  }
  return grid;
}

// 把表头映射到标准字段（兼容中英文/别名），找不到用列位置补。
const EXCEL_COL_MAP = [
  { key: 'name', names: ['游戏名', '游戏名称', 'name', '名称'] },
  { key: 'price', names: ['原价', 'price'] },
  { key: 'now', names: ['现价', '折后价', '史低价', 'now'] },
  { key: 'rating', names: ['好评率', 'rating', '评价'] },
  { key: 'discount', names: ['折扣力度', '折扣档', 'discount'] },
  { key: 'deadline', names: ['截止日期', '折扣截止', 'deadline', 'date'] },
  { key: 'tag1', names: ['标签1', 'tag1', '标签'] },
  { key: 'tag2', names: ['标签2', 'tag2'] },
];

// 将 grid 二维数组转成对象行（跳过表头），返回 { headers, cols, rows, total }。
function mapExcelGrid(grid) {
  const headers = grid[0] || [];
  const colIdx = {}; // 字段名 -> 列下标
  headers.forEach((h, i) => {
    if (colIdx[h] !== undefined) return;
    const clean = String(h).trim();
    for (const def of EXCEL_COL_MAP) {
      if (colIdx[def.key] !== undefined) continue;
      if (def.names.some((n) => clean === n || clean.toLowerCase() === n.toLowerCase())) {
        colIdx[def.key] = i;
        break;
      }
    }
  });
  // 未命名的列按位置兜底（无表头或表头名不匹配时）
  const rows = [];
  for (let r = 1; r < grid.length; r++) {
    const cells = grid[r];
    if (!cells.length) continue;
    if (cells.every((c) => !String(c).trim())) continue; // 空行
    const obj = {};
    for (const def of EXCEL_COL_MAP) {
      const idx = colIdx[def.key] !== undefined ? colIdx[def.key] : EXCEL_COL_MAP.indexOf(def);
      obj[def.key] = (cells[idx] !== undefined ? String(cells[idx]) : '').trim();
    }
    if (!obj.name && !obj.price && !obj.now) continue; // 无有效内容
    // 保留原始全部列（key价格/语言等额外字段，供卡片渲染扩展）
    const raw = {};
    headers.forEach((h, i) => {
      const hh = String(h).trim();
      if (hh && cells[i] !== undefined && String(cells[i]).trim()) raw[hh] = String(cells[i]).trim();
    });
    obj.raw = raw;
    rows.push(obj);
  }
  return { headers, colIdx, rows, total: rows.length };
}

// POST /api/excel/upload?name=xx.xlsx ：上传 xlsx（body 二进制），返回可用 sheet 列表。
function handleExcelUpload(req, res, urlObj) {
  const name = String(urlObj.searchParams.get('name') || '').trim();
  const dir = urlObj.searchParams.get('dir') || DEFAULT_EXCEL_DIR;
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return json(res, 400, { error: '文件名无效' });
  if (!/\.xlsx?$/i.test(name)) return json(res, 400, { error: '仅支持 .xlsx 文件' });
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return json(res, 400, { error: `无法创建目录：${e.message}` }); }
  const target = path.join(dir, name);
  const ws = fs.createWriteStream(target);
  req.pipe(ws);
  ws.on('finish', () => {
    try {
      const buf = fs.readFileSync(target);
      const sheets = listXlsxSheets(buf);
      if (!sheets.length) throw new Error('未识别到工作表');
      const st = fs.statSync(target);
      return json(res, 200, { ok: true, name, size: st.size, sheets });
    } catch (e) {
      try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
      return json(res, 400, { error: `解析失败（文件可能损坏或不是 Excel）：${e.message}` });
    }
  });
  ws.on('error', (e) => json(res, 500, { error: `写入失败：${e.message}` }));
  req.on('aborted', () => { try { ws.destroy(); fs.rmSync(target, { force: true }); } catch { /* ignore */ } });
}

// GET /api/excel/preview?file=xx.xlsx&sheet=名称&dir=... ：解析指定 sheet 并返回表头 + 前 50 行 + 字段映射。
function handleExcelPreview(urlObj, res) {
  const dir = urlObj.searchParams.get('dir') || DEFAULT_EXCEL_DIR;
  const file = String(urlObj.searchParams.get('file') || '').trim();
  const sheetName = String(urlObj.searchParams.get('sheet') || '').trim();
  if (!file || file.includes('..') || file.includes('/') || file.includes('\\')) return json(res, 400, { error: '文件名无效' });
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) return json(res, 404, { error: `文件不存在：${file}` });
  try {
    const buf = fs.readFileSync(filePath);
    const sheets = listXlsxSheets(buf);
    const target = sheets.find((s) => s.name === sheetName) || sheets[0];
    if (!target) return json(res, 400, { error: '没有可用的工作表' });
    const grid = readXlsxSheet(buf, target.path);
    if (!grid.length) return json(res, 200, { ok: true, sheet: target.name, headers: [], rows: [], total: 0 });
    const mapped = mapExcelGrid(grid);
    return json(res, 200, {
      ok: true,
      sheet: target.name,
      headers: mapped.headers,
      cols: mapped.colIdx,
      rows: mapped.rows.slice(0, 50),
      total: mapped.rows.length,
    });
  } catch (e) {
    return json(res, 400, { error: `解析失败：${e.message}` });
  }
}

// ── A4 自动贴合：画面按配音时长 + 余量剪切拼接，配音按段贴入 ──────────────────

// 用 ffmpeg 读取媒体时长（秒）。stderr 重定向到文件后解析 Duration 行。
async function runFfDuration(file) {
  const ff = resolveFfmpeg();
  if (!ff) throw new Error('未找到 ffmpeg');
  const errFile = path.join(SCRIPT_DIR, `.tmp_dur_${Date.now()}_${randomUUID().slice(0, 8)}.txt`);
  try { fs.rmSync(errFile, { force: true }); } catch { /* ignore */ }
  const errFd = fs.openSync(errFile, 'w');
  await new Promise((resolve, reject) => {
    let child;
    try {
      // 仅 -i（不加 -f null -），ffmpeg 打开输入即打印 Duration 后退出，毫秒级且不整段解码
      child = spawn(ff, ['-i', file], { stdio: ['ignore', 'ignore', errFd], windowsHide: true });
    } catch (e) {
      try { fs.closeSync(errFd); } catch { /* ignore */ }
      return reject(e);
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 120000);
    child.on('error', (e) => { clearTimeout(timer); try { fs.closeSync(errFd); } catch { /* ignore */ } reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      try { fs.closeSync(errFd); } catch { /* ignore */ }
      resolve();
    });
  });
  let text = '';
  try { text = fs.readFileSync(errFile, 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(errFile, { force: true }); } catch { /* ignore */ }
  const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text);
  if (!m) throw new Error(`无法读取媒体时长：${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// 解析 srt 总时长（末条字幕结束时间，秒）。
function parseSrtDuration(srtPath) {
  try {
    const text = fs.readFileSync(srtPath, 'utf8');
    const re = /(\d{1,2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2}),(\d{3})/g;
    let m;
    let last = 0;
    while ((m = re.exec(text))) {
      const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
      if (end > last) last = end;
    }
    return last > 0 ? last : null;
  } catch {
    return null;
  }
}

// 配音时长：优先同目录同名 .srt（用户 B1 产物），否则实测音频时长。
async function voiceDurationOf(voicePath) {
  const srt = voicePath.replace(/\.[^.]+$/, '') + '.srt';
  const fromSrt = parseSrtDuration(srt);
  if (fromSrt !== null) return fromSrt;
  return runFfDuration(voicePath);
}

// POST /api/compose-auto ：素材↔配音按顺序配对自动成片（支持段间淡入淡出转场）。
// body: {
//   materials: [{ path, start? }]  素材顺序（start 默认 0）
//   voices:    [{ path }]          配音顺序（与素材一一对应）
//   padding: 2,                    每段画面比配音多出的余量秒数
//   transition: 0.5,               段间淡入淡出秒数（0 = 硬切快速路径）
//   fps: 30,                       转场重编码时的统一帧率
//   outDir, outName?
// }
async function handleComposeAuto(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const materials = Array.isArray(payload.materials) ? payload.materials : [];
  const voices = Array.isArray(payload.voices) ? payload.voices : [];
  if (!materials.length) return json(res, 400, { error: '请至少选择一个素材' });
  if (!voices.length) return json(res, 400, { error: '请至少选择一段配音' });
  if (materials.length !== voices.length) {
    return json(res, 400, { error: `素材(${materials.length})与配音(${voices.length})数量不一致，需一一对应` });
  }
  const n = materials.length;
  const padding = Math.max(0, Number(payload.padding) || 2);
  const transition = Math.max(0, Number(payload.transition) || 0);
  const fps = Math.min(60, Math.max(12, Number(payload.fps) || 30));
  const outDir = String(payload.outDir || '').trim() || 'E:/worddeepseek/videocut/product';
  const ff = resolveFfmpeg();
  if (!ff) return json(res, 500, { error: '未找到 ffmpeg' });
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { return json(res, 400, { error: `无法创建成品目录：${e.message}` }); }

  const tmpDir = path.join(SCRIPT_DIR, `.tmp_auto_${Date.now()}_${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // ── 1) 计算各段画面时长 + 剪切（去原声） ──
    const segLens = [];
    const segTitles = [];
    for (let i = 0; i < n; i++) {
      const mat = String(materials[i].path || '').trim();
      const voice = String(voices[i].path || '').trim();
      if (!fs.existsSync(mat)) throw new Error(`素材不存在：${mat}`);
      if (!fs.existsSync(voice)) throw new Error(`配音不存在：${voice}`);
      const start = Math.max(0, Number(materials[i].start) || 0);
      const tVoice = await voiceDurationOf(voice);
      const segLen = tVoice + padding;
      if (transition > 0 && segLen <= transition + 0.2) {
        throw new Error(`段 ${i + 1} 画面长度 ${segLen.toFixed(1)}s 过短，无法容纳 ${transition}s 转场（请减小转场或余量）`);
      }
      const matDur = await runFfDuration(mat);
      if (start + segLen > matDur + 0.5) {
        throw new Error(`素材 ${i + 1}（${path.basename(mat)}）不够剪：需要从 ${start.toFixed(1)}s 剪 ${segLen.toFixed(1)}s，但素材总长仅 ${matDur.toFixed(1)}s`);
      }
      const clip = path.join(tmpDir, `clip${i + 1}.mp4`);
      await runLocal(ff, ['-y', '-loglevel', 'error', '-ss', String(start), '-i', mat, '-t', String(segLen), '-an', '-c:v', 'copy', '-avoid_negative_ts', 'make_zero', clip], { timeoutMs: 120000 });
      segLens.push(segLen);
      segTitles.push(path.basename(mat));
    }

    // 配音贴入点（秒）：段 i 在成片时间轴上的起点
    //   硬切：acc_i = ΣL[0..i-1]
    //   转场：offset_i = acc_i - i * transition（段 i≥1 作为 xfade 第二输入进入的时刻）
    const accOf = (k) => segLens.slice(0, k).reduce((a, b) => a + b, 0);
    const delaySec = (i) => (i === 0 ? 0 : accOf(i) - i * transition);
    const totalDur = accOf(n) - (n > 1 ? (n - 1) * transition : 0);

    // ── 2) 画面视频（无音轨） ──
    const video = path.join(tmpDir, 'video.mp4');
    if (transition > 0 && n > 1) {
      // 淡入淡出转场：统一帧率后 xfade 链式合成（重编码）
      const clips = segLens.map((_, i) => path.join(tmpDir, `clip${i + 1}.mp4`));
      const args = ['-y', '-loglevel', 'error'];
      clips.forEach((c) => args.push('-i', c));
      const fc = [];
      clips.forEach((_, i) => fc.push(`[${i}:v]fps=${fps},format=yuv420p[v${i}]`));
      let prev = 'v0';
      for (let k = 1; k < n; k++) {
        const offset = accOf(k) - k * transition;
        fc.push(`[${prev}][v${k}]xfade=transition=fade:duration=${transition.toFixed(3)}:offset=${offset.toFixed(3)}[x${k}]`);
        prev = `x${k}`;
      }
      fc.push(`[${prev}]format=yuv420p[vout]`);
      args.push('-filter_complex', fc.join(';'), '-map', '[vout]', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', video);
      await runLocal(ff, args, { timeoutMs: 900000 });
    } else if (n === 1) {
      // 单段：直接复用剪切段（转场无意义）
      fs.copyFileSync(path.join(tmpDir, 'clip1.mp4'), video);
    } else {
      // 硬切：流拷贝 concat（timescale 归一后拼接）
      const listFile = path.join(tmpDir, 'list.txt');
      const normList = [];
      for (let i = 0; i < n; i++) {
        const norm = path.join(tmpDir, `norm${i + 1}.mp4`);
        await runLocal(ff, ['-y', '-loglevel', 'error', '-i', path.join(tmpDir, `clip${i + 1}.mp4`), '-c', 'copy', '-video_track_timescale', '15360', norm], { timeoutMs: 120000 });
        normList.push(norm);
      }
      fs.writeFileSync(listFile, normList.map((c) => `file ${escapeConcatPath(c)}`).join('\n'), 'utf8');
      await runLocal(ff, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', video], { timeoutMs: 600000 });
    }
    if (!fs.existsSync(video)) throw new Error('画面合成失败（未生成视频）');

    // ── 3) 混音：静音底 + 配音按延迟贴入 ──
    const baseName = (payload.outName && String(payload.outName).trim())
      ? String(payload.outName).trim()
      : `${todayStr()}_自动贴合`;
    const dest = uniquePath(path.join(outDir, `${sanitizeName(baseName)}.mp4`));

    const args = ['-y', '-loglevel', 'error', '-i', video, '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`];
    voices.forEach((v) => args.push('-i', v.path));
    const fc = [];
    fc.push(`[1:a]atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS[base]`);
    voices.forEach((_, k) => {
      const idx = 2 + k;
      const d = Math.max(0, Math.round(delaySec(k) * 1000));
      fc.push(`[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo,adelay=${d}|${d}[vo${k}]`);
    });
    const ins = ['[base]'].concat(voices.map((_, k) => `[vo${k}]`)).join('');
    fc.push(`${ins}amix=inputs=${1 + n}:duration=longest:normalize=0[aout]`);
    args.push('-filter_complex', fc.join(';'), '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', dest);
    await runLocal(ff, args, { timeoutMs: 600000 });
    if (!fs.existsSync(dest)) throw new Error('合成失败（未生成文件）');
    const st = fs.statSync(dest);
    return json(res, 200, {
      ok: true,
      output: dest,
      size: st.size,
      duration: Math.round(totalDur * 100) / 100,
      transition,
      segments: voices.map((v, i) => ({
        index: i + 1,
        delayMs: Math.max(0, Math.round(delaySec(i) * 1000)),
        voice: path.basename(v.path),
        material: segTitles[i],
      })),
    });
  } catch (e) {
    return json(res, 502, { error: `自动成片失败：${e.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── C1 游戏卡片：drawtext 白底卡片，按段落窗口叠加到成片 ──────────────────────

// 中文字体探测（标题粗体优先，正文常规）。
function resolveCnFont(bold) {
  const dir = 'C:/Windows/Fonts';
  const cands = bold
    ? ['msyhbd.ttc', 'msyh.ttc', 'simhei.ttf', 'msyhl.ttc', 'simsun.ttc']
    : ['msyh.ttc', 'msyhbd.ttc', 'simhei.ttf', 'simsun.ttc', 'msyhl.ttc'];
  for (const f of cands) {
    try { if (fs.existsSync(path.join(dir, f))) return `${dir}/${f}`; } catch { /* ignore */ }
  }
  return null;
}

// filter 值转义：反斜杠/冒号/百分号/单引号（ffmpeg 滤镜参数层 av_opt 的转义；% 用 \% 转义）
function escF(v) {
  return String(v ?? '').replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/'/g, "\\'");
}

// 好评率显示：0.95 → 95.00%；83 → 83.00%；带 % 原样
function fmtRating(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (s.includes('%')) return s;
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  const p = n <= 1 ? n * 100 : n;
  return `${p.toFixed(2)}%`;
}

// 从 raw 额外列里探测补充信息（key 价格 / 中文支持），列名模糊匹配。
function probeExtra(raw) {
  let keyPrice = '';
  let hasCn = '';
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const kk = String(k);
      const vv = String(v ?? '');
      if (!keyPrice && /key|激活码|密钥/i.test(kk)) keyPrice = vv;
      if (!hasCn && (/中文|语言|简中|汉化|字幕/i.test(kk) || /中文|简中|汉化/i.test(vv))) hasCn = '有中文';
    }
  }
  return { keyPrice, hasCn };
}

// 由卡片字段生成显示行：{ text, fs(字号), color }
function buildCardLines(c) {
  const lines = [];
  lines.push({ text: String(c.name || '未知游戏').trim(), fs: 0, bold: true });
  const priceBits = [];
  if (c.price) priceBits.push(`原${c.price}`);
  if (c.now) priceBits.push(`现${c.now}`);
  if (c.discount) priceBits.push(String(c.discount));
  if (c.deadline) priceBits.push(`截止${c.deadline}`);
  if (priceBits.length) lines.push({ text: priceBits.join(' '), fs: 1, color: '#C0392B' });
  const tags = [String(c.tag1 || '').trim(), String(c.tag2 || '').trim()].filter(Boolean);
  if (tags.length) lines.push({ text: `标签：${tags.join(' ')}`, fs: 1, color: '#444444' });
  const rating = fmtRating(c.rating);
  if (rating) lines.push({ text: `好评率：${rating}`, fs: 1, color: '#333333' });
  const extra = probeExtra(c.raw);
  if (extra.keyPrice) lines.push({ text: `Key价格 ${extra.keyPrice}`, fs: 1, color: '#333333' });
  if (extra.hasCn) lines.push({ text: extra.hasCn, fs: 1, color: '#333333' });
  return lines;
}

// POST /api/cards-overlay ：把多张游戏卡片按时间窗口叠加到视频左上角。
// body: { video, cards: [{start,end,name,price,now,discount,deadline,rating,tag1,tag2,raw?}], outDir, outName? }
async function handleCardsOverlay(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const video = String(payload.video || '').trim();
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  if (!video) return json(res, 400, { error: '请选择要叠加卡片的视频' });
  if (!fs.existsSync(video)) return json(res, 404, { error: `视频不存在：${video}` });
  if (!cards.length) return json(res, 400, { error: '请至少提供一张卡片' });
  const outDir = String(payload.outDir || '').trim() || 'E:/worddeepseek/videocut/product';
  const ff = resolveFfmpeg();
  if (!ff) return json(res, 500, { error: '未找到 ffmpeg' });
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { return json(res, 400, { error: `无法创建成品目录：${e.message}` }); }
  const titleFont = resolveCnFont(true);
  const bodyFont = resolveCnFont(false);
  if (!titleFont || !bodyFont) return json(res, 500, { error: '未找到中文字体（需系统装有微软雅黑/黑体）' });

  const baseName = (payload.outName && String(payload.outName).trim())
    ? String(payload.outName).trim()
    : `${path.basename(video).replace(/\.[^.]+$/, '')}_卡片版`;
  const dest = uniquePath(path.join(outDir, `${sanitizeName(baseName)}.mp4`));

  const X = 24; // 卡片左上角
  const Y = 24;
  const PAD_X = 14;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 12;

  const fc = [];
  cards.forEach((c) => {
    const start = Math.max(0, Number(c.start) || 0);
    const end = Math.max(start + 0.2, Number(c.end) || start + 5);
    const enable = `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`;
    const lines = buildCardLines(c);
    // 卡片宽：按最长行粗估，至少 300，最多 640
    let w = 300;
    lines.forEach((l) => {
      const len = String(l.text).length;
      const est = l.fs === 0 ? 28 * Math.min(len, 22) : 19 * len;
      if (est > w) w = est;
    });
    w = Math.min(640, Math.max(300, w + PAD_X * 2 + 16));
    // 行高
    const rowHs = lines.map((l) => (l.fs === 0 ? 44 : 28));
    const h = PAD_TOP + rowHs.reduce((a, b) => a + b, 0) + PAD_BOTTOM;
    // 白底 + 红粉边框（外框色 3px + 内白半透明）＋ 文本行（全部挂同一时间窗口）
    fc.push(`drawbox=x=${X - 3}:y=${Y - 3}:w=${w + 6}:h=${h + 6}:color=0xF2A0B8@0.95:t=fill:${enable}`);
    fc.push(`drawbox=x=${X}:y=${Y}:w=${w}:h=${h}:color=white@0.45:t=fill:${enable}`);
    let y = Y + PAD_TOP;
    lines.forEach((l, li) => {
      // 半角 % 换成全角 ％，规避 drawtext 多层转义问题；其余字符 escF 处理
      const safeText = String(l.text).replace(/%/g, '％');
      if (l.fs === 0) {
        const len = String(l.text).length;
        const fs = len > 26 ? 19 : len > 18 ? 23 : 28;
        fc.push(`drawtext=fontfile='${escF(titleFont)}':text='${escF(safeText)}':x=${X + PAD_X}:y=${y}:fontsize=${fs}:fontcolor=black:${enable}`);
      } else {
        const fs = l.color === '#C0392B' ? 22 : 20;
        fc.push(`drawtext=fontfile='${escF(bodyFont)}':text='${escF(safeText)}':x=${X + PAD_X}:y=${y + 2}:fontsize=${fs}:fontcolor=${l.color || 'black'}:${enable}`);
      }
      y += rowHs[li];
    });
  });

  const chain = `[0:v]${fc.join(',')}[vout]`;
  const args = ['-y', '-loglevel', 'error', '-i', video, '-filter_complex', chain, '-map', '[vout]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy', dest];
  // 排错：把 ffmpeg 报错写文件，失败时带回详细原因
  const errFile = path.join(SCRIPT_DIR, `.tmp_cards_${Date.now()}_${randomUUID().slice(0, 8)}.txt`);
  try {
    const errFd = fs.openSync(errFile, 'w');
    try {
      await new Promise((resolve, reject) => {
        let child;
        try {
          child = spawn(ff, args, { stdio: ['ignore', 'ignore', errFd], windowsHide: true });
        } catch (e2) { return reject(e2); }
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`退出码 ${code}`))));
      });
    } finally {
      try { fs.closeSync(errFd); } catch { /* ignore */ }
    }
    if (!fs.existsSync(dest)) throw new Error('合成失败（未生成文件）');
    const st = fs.statSync(dest);
    return json(res, 200, { ok: true, output: dest, size: st.size, cards: cards.length });
  } catch (e) {
    let detail = e.message;
    try {
      const t = fs.readFileSync(errFile, 'utf8');
      const lines = t.split(/\r?\n/).filter((l) => l.trim()).slice(-8).join(' | ');
      if (lines) detail += ` ｜ ffmpeg: ${lines}`;
    } catch { /* ignore */ }
    return json(res, 502, { error: `卡片叠加失败：${detail}` });
  } finally {
    try { fs.rmSync(errFile, { force: true }); } catch { /* ignore */ }
  }
}

// ── Steam 链接直抓游戏卡片数据（无需 Excel）─────────────────────────────────

// 商店页抓取"折扣截止日期 + 热门用户标签"（同一页面一次下载）。
// 截止来源：中文页文本 "每日特惠！9 月 18 日截止"；标签来源：页面内 "tags":["策略","回合战略",...]。
async function fetchStoreExtras(appid) {
  const empty = { deadline: '', tags: [] };
  try {
    const r = await fetchText(`https://store.steampowered.com/app/${appid}/?l=schinese&cc=cn`, { timeoutMs: 30000 });
    let deadline = '';
    const cm = /game_purchase_discount_countdown">([^<]{0,100})</.exec(r.text);
    if (cm) {
      const t = cm[1];
      const zh = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(t);
      if (zh) deadline = `${Number(zh[1])}.${Number(zh[2])}`;
      else {
        const en = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.exec(t);
        if (en) deadline = `${en[2]}.${Number(en[1])}`;
        else {
          const en2 = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})/.exec(t);
          if (en2) deadline = `${en2[1]}.${Number(en2[2])}`;
        }
      }
    }
    let tags = [];
    const tm = /"tags":\[([^\]]*)\]/.exec(r.text);
    if (tm) {
      try {
        const arr = JSON.parse(`[${tm[1]}]`);
        tags = arr.filter((x) => typeof x === 'string' && x.trim());
      } catch { /* ignore */ }
    }
    return { deadline, tags };
  } catch {
    return empty;
  }
}

// 好评率（0-1 小数）：appreviews 接口 all 语言统计。
async function fetchSteamRating(appid) {
  try {
    const r = await fetchText(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&filter=all&purchase_type=all`, { timeoutMs: 30000 });
    const j = JSON.parse(r.text);
    const q = j && j.query_summary;
    if (q && q.total_reviews > 0) {
      return Math.round((q.total_positive / q.total_reviews) * 10000) / 10000; // 0.94
    }
  } catch { /* ignore */ }
  return '';
}

// POST /api/steam/cards ：{ links: [Steam链接或appid...] } → 逐游戏抓取卡片字段（顺序=链接顺序）。
async function handleSteamCards(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const links = (Array.isArray(payload.links) ? payload.links : []).map(String).filter((s) => s.trim());
  if (!links.length) return json(res, 400, { error: '请粘贴至少一个 Steam 链接' });
  const jobs = [];
  const seen = new Set();
  for (const raw of links) {
    const appid = extractAppId(raw);
    if (!appid) {
      jobs.push({ appid: null, error: '无法识别 appid', raw });
      continue;
    }
    if (seen.has(appid)) continue;
    seen.add(appid);
    jobs.push({ appid });
  }

  const rows = [];
  let errs = [];
  await runPool(jobs, async (job) => {
    if (!job.appid) {
      errs.push(job.raw);
      return;
    }
    try {
      const data = await fetchApp(job.appid);
      if (!data) {
        rows.push({ appid: job.appid, name: `App ${job.appid}`, error: '未返回数据（不存在/地区受限/需年龄验证）' });
        return;
      }
      const po = data.price_overview;
      const [rating, extras] = await Promise.all([fetchSteamRating(job.appid), fetchStoreExtras(job.appid)]);
      const gens = (data.genres || []).map((g) => g.description).filter(Boolean);
      const cats = (data.categories || []).map((c) => c.description).filter(Boolean);
      // 标签：优先商店页热门用户标签（前 2），否则官方类型
      const tagSrc = extras.tags.length >= 1 ? extras.tags : gens.concat(cats);
      const price = po ? String((po.initial || 0) / 100) : '';
      const now = po ? String((po.final || 0) / 100) : '';
      const discount = po && po.discount_percent ? `-${po.discount_percent}%` : '';
      rows.push({
        appid: job.appid,
        name: data.name || '',
        price: price === now ? '' : price,
        now: now || '',
        rating: rating || '',
        discount: discount || '',
        deadline: extras.deadline || '',
        tag1: tagSrc[0] || '',
        tag2: tagSrc[1] || '',
        raw: null,
        source: 'steam',
      });
    } catch (e) {
      rows.push({ appid: job.appid, error: `抓取失败：${e.message}` });
    }
  }, 3);
  return json(res, 200, { ok: true, rows, errs });
}

// GET /api/materials?dir=... ：列出素材目录的 mp4（附带解析出的游戏名）。
function handleMaterials(urlObj, res) {
  const dir = urlObj.searchParams.get('dir') || DEFAULT_DIR;
  const files = listFiles(dir).filter((f) => /\.(mp4|webm|mkv|mov)$/i.test(f.name)).map((f) => ({
    ...f,
    gameName: parseGameNameFromFile(f.name),
  }));
  return json(res, 200, { dir, files });
}

// POST /api/compose ：剪辑拼接。
async function handleCompose(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const materials = Array.isArray(payload.materials) ? payload.materials : [];
  if (!materials.length) return json(res, 400, { error: '请至少选择一个素材' });
  const outDir = String(payload.outDir || '').trim() || 'E:/worddeepseek/videocut/product';
  try {
    fs.mkdirSync(outDir, { recursive: true });
  } catch (e) {
    return json(res, 400, { error: `无法创建成品目录：${e.message}` });
  }
  try {
    const r = await composeVideos(materials, outDir, payload.outName);
    return json(res, 200, { ok: true, ...r });
  } catch (e) {
    return json(res, 502, { error: `剪辑拼接失败：${e.message}` });
  }
}

// ── 网页界面 ─────────────────────────────────────────────────────────────────

// 注意：用 String.raw 包裹；页面里的 JS 不要使用反引号模板字符串（避免提前截断）。
const PAGE = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Steam 游戏视频批量下载</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 980px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 16px; line-height: 1.7; }
  label { font-size: 13px; color: #777; display: block; margin: 12px 0 4px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 140px; padding: 10px 12px; font-size: 13px; font-family: Consolas, Menlo, monospace; border: 1px solid #888; border-radius: 6px; resize: vertical; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 10px; }
  input[type=text] { flex: 1; min-width: 240px; padding: 9px 12px; font-size: 13px; border: 1px solid #888; border-radius: 6px; }
  select { padding: 9px 10px; font-size: 13px; border: 1px solid #888; border-radius: 6px; background: transparent; }
  button { padding: 10px 20px; font-size: 14px; border: none; border-radius: 6px; background: #1a73e8; color: #fff; cursor: pointer; }
  button:hover { background: #1558b0; }
  button.accent { background: #188038; }
  button.accent:hover { background: #11602c; }
  button.danger { background: #c5221f; }
  button.danger:hover { background: #9f1a17; }
  button.ghost { background: rgba(127,127,127,.15); color: inherit; border: 1px solid #888; padding: 6px 12px; font-size: 13px; }
  button.ghost:hover { background: rgba(127,127,127,.3); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  .chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #888; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 14px 16px; margin-top: 12px; }
  .card h2 { margin: 0 0 8px; font-size: 17px; }
  .it { border: 1px solid #ddd; border-radius: 8px; padding: 10px 12px; margin-top: 10px; background: rgba(127,127,127,.05); }
  .it .top { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; align-items: baseline; }
  .it .nm { font-size: 14px; font-weight: 600; }
  .it .ap { color: #888; font-size: 12px; margin-left: 8px; }
  .it .st { font-size: 12px; white-space: nowrap; }
  .st.pending { color: #888; } .st.fetch { color: #1a73e8; } .st.dl { color: #e37400; }
  .st.ok { color: #1a7a3a; } .st.err { color: #b00020; } .st.skip { color: #5f6368; } .st.cancel { color: #777; }
  .track { height: 8px; background: rgba(127,127,127,.2); border-radius: 4px; overflow: hidden; margin-top: 8px; }
  .bar { height: 100%; width: 0%; background: linear-gradient(90deg,#1a73e8,#4caf50); border-radius: 4px; transition: width .3s ease; }
  .bar.indet { width: 40%; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: 0%; } 50% { margin-left: 60%; } 100% { margin-left: 0%; } }
  .meta { color: #777; font-size: 12px; margin-top: 6px; word-break: break-all; }
  .logline { color: #555; font-size: 11px; margin-top: 5px; font-family: Consolas, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
  .errmsg { color: #b00020; font-size: 12px; margin-top: 4px; word-break: break-all; }
  .files { margin-top: 8px; }
  .file { display: flex; justify-content: space-between; gap: 10px; padding: 6px 2px; border-bottom: 1px dashed rgba(127,127,127,.2); font-size: 13px; }
  .file .fn { word-break: break-all; }
  .file .sz { color: #888; white-space: nowrap; }
  .sum { margin-top: 10px; font-size: 13px; color: #444; }
  #status { margin-left: 10px; color: #777; font-size: 13px; }
  .empty { color: #999; font-size: 13px; padding: 8px 0; }
  .warn { color: #b06000; font-size: 12px; margin-top: 6px; }
  code { background: rgba(127,127,127,.12); padding: 1px 5px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body>
<h1>🎬 Steam 游戏视频批量下载</h1>
<div class="sub">
  每行粘贴一个 Steam 商店链接（或纯数字 appid），点击「开始下载」后自动识别各游戏，把每个游戏的<strong>第一个宣传视频</strong>下载到本地素材目录。<br>
  视频源为 HLS/DASH 流，由本机 <code>N_m3u8DL-CLI</code> 下载并合并成 mp4；文件名格式：<code>当天日期_游戏名_视频素材.mp4</code>。
</div>

<label for="links">Steam 链接（每行一个，可混入纯数字 appid）</label>
<textarea id="links" placeholder="https://store.steampowered.com/app/1623730/Palworld/
https://store.steampowered.com/app/105600/Terraria/
https://store.steampowered.com/app/648800/Raft/"></textarea>

<div class="row">
  <input type="text" id="dir" title="视频保存目录" />
  <select id="quality" title="画质">
    <option value="max">最高画质</option>
    <option value="480">480p</option>
  </select>
  <label class="chk"><input type="checkbox" id="skip" checked /> 跳过已存在的文件</label>
</div>

<div id="engineInfo" class="warn"></div>

<div class="row">
  <button id="start" class="accent">▶ 开始下载</button>
  <button id="cancel" class="danger" disabled>取消任务</button>
  <button id="openDir" class="ghost">📂 打开素材文件夹</button>
  <button id="refresh" class="ghost">🔄 刷新文件列表</button>
  <span id="status"></span>
</div>

<div id="preview" class="card" style="display:none">
  <h2>链接解析</h2>
  <div id="previewBody"></div>
</div>

<div id="jobBox" style="display:none">
  <div class="card">
    <h2>下载任务 <span id="jobDir"></span> <span id="jobState"></span></h2>
    <div id="items"></div>
    <div id="sum" class="sum"></div>
  </div>
</div>

<div class="card">
  <h2>已下载文件</h2>
  <div id="files"><div class="empty">（尚未下载任何文件）</div></div>
</div>

<div class="card">
  <h2>🎙️ 配音上传（真人配音 · 分段）</h2>
  <div class="sub" style="margin:0 0 8px">
    一次拖入/选择多段真人配音（mp3/wav/m4a…），建议文件名以 <code>01_</code> <code>02_</code> <code>03_</code> 为前缀，
    程序按数字大小排序 —— <strong>顺序 = 素材段顺序 = Excel 行顺序</strong>（第 1 个 = 配音01 = 素材段1）。
    同名文件重新上传会覆盖。
  </div>
  <div class="row">
    <input type="text" id="voiceDir" title="配音目录" placeholder="配音目录（默认 E:/worddeepseek/videocut/voice）" />
    <button id="voicePick" class="ghost">📁 选择文件</button>
    <input type="file" id="voiceFileInput" multiple accept=".mp3,.wav,.m4a,.aac,.flac,.ogg,.wma,.opus,audio/*" style="display:none" />
    <button id="voiceRefresh" class="ghost">🔄 刷新列表</button>
    <button id="voiceClear" class="ghost">🗑️ 清空列表</button>
    <span id="voiceStatus"></span>
  </div>
  <div id="voiceUploadList" class="files"></div>
  <div class="card" style="margin-top:10px;padding:10px 12px">
    <h2 style="font-size:14px;margin:0 0 6px">已上传配音（按 01/02/03 顺序排列）</h2>
    <div id="voiceFiles"><div class="empty">（暂无配音，先上传）</div></div>
  </div>
</div>

<div class="card">
  <h2>📝 文案 → 字幕</h2>
  <div class="sub" style="margin:0 0 8px">
    选择一段配音 + 粘贴（或载入）对应的文案 → 程序用本地语音识别拿到<strong>时间轴</strong>（whisper，含句级时间戳），
    再用你的文案<strong>矫正错字</strong>，生成 .srt 字幕。文案会自动分句，识别约需数秒到一分钟（配音越长越久）。
  </div>
  <div class="row">
    <select id="subVoiceSel" style="flex:1;min-width:200px"></select>
  </div>
  <div class="row">
    <input type="text" id="subOutDir" placeholder="字幕保存目录（留空 = 与配音同目录）" style="flex:1" />
  </div>
  <label for="subScript" style="margin-top:10px">文案内容（每行一句或用标点分句均可）</label>
  <textarea id="subScript" placeholder="粘贴这里：例如&#10;幻兽帕鲁，一款开放世界的生存建造游戏……&#10;今天就介绍到这里，感兴趣的话快去试试吧。"></textarea>
  <div class="row">
    <button id="subPickTxt" class="ghost">📄 载入文案文件(.txt)</button>
    <input type="file" id="subTxtInput" accept=".txt,text/plain" style="display:none" />
    <button id="subGen" class="accent">🎬 生成字幕</button>
    <button id="subCopy" class="ghost" style="display:none">📋 复制 srt</button>
    <span id="subStatus"></span>
  </div>
  <div id="subResult"></div>
</div>

<div class="card">
  <h2>📊 游戏数据（Excel / Steam 直抓）</h2>
  <div class="sub" style="margin:0 0 8px">
    数据来源二选一：<b>Excel 表格</b> 或 <b>Steam 链接直抓</b>（从商店接口自动取价格/折扣/好评率/标签/截止日期，无需表格）。
    解析结果供"游戏卡片 / 片尾总表"使用。
  </div>
  <div class="row">
    <button id="srcExcelBtn" class="ghost">📊 Excel 上传</button>
    <button id="srcSteamBtn" class="ghost">🔗 Steam 链接直抓</button>
  </div>
  <div id="srcExcelBox">
    <div class="row">
      <input type="text" id="excelDir" placeholder="Excel 目录（默认 E:/worddeepseek/videocut/excel）" />
      <button id="excelPick" class="ghost">📁 选择 xlsx 上传</button>
      <input type="file" id="excelFile" accept=".xlsx" style="display:none" />
      <select id="excelSheet" style="min-width:140px"></select>
      <button id="excelLoad" class="ghost">🔍 解析所选工作表</button>
      <span id="excelStatus"></span>
    </div>
  </div>
  <div id="srcSteamBox" style="display:none">
    <label for="steamLinks" style="margin-top:8px">Steam 链接（每行一个，顺序 = 段落/素材顺序）</label>
    <textarea id="steamLinks" placeholder="https://store.steampowered.com/app/590380/Into_the_Breach/&#10;https://store.steampowered.com/app/1623730/Palworld/"></textarea>
    <div class="row">
      <button id="steamFetch" class="ghost">🔍 抓取游戏数据</button>
      <span id="steamStatus"></span>
    </div>
  </div>
  <div id="excelInfo"></div>
  <div id="excelPreview"></div>
</div>

<div class="card">
  <h2>⏱️ 自动贴合成片（按配音时长）</h2>
  <div class="sub" style="margin:0 0 8px">
    素材与配音<strong>按顺序一一对应</strong>（素材1↔配音1↔Excel行1）。每段画面时长 = 配音时长（优先同名 .srt，否则实测音频）+ <strong>余量</strong>秒；
    画面自动剪切并去掉素材原声，段间按<strong>转场</strong>秒数淡入淡出（0=硬切），配音按段落起点贴入音轨，输出成片。
  </div>
  <div class="row">
    <input type="text" id="autoMatDir" placeholder="素材目录（默认下载素材目录）" />
    <button id="autoLoadMat" class="ghost">📁 载入素材</button>
    <input type="text" id="autoVoiceDir" placeholder="配音目录（默认配音目录）" style="flex:1" />
    <button id="autoLoadVoice" class="ghost">🎙️ 载入配音</button>
  </div>
  <div id="autoPairInfo" class="warn"></div>
  <div id="autoRows"></div>
  <div class="row">
    <label class="chk">画面余量（秒）<input type="number" id="autoPadding" value="2" min="0" max="30" style="width:60px" /></label>
    <label class="chk">段间转场（秒，0=硬切）<input type="number" id="autoTransition" value="0.5" min="0" max="5" step="0.1" style="width:60px" /></label>
    <input type="text" id="autoOutDir" placeholder="成品目录（默认 E:/worddeepseek/videocut/product）" style="flex:1" />
    <input type="text" id="autoOutName" placeholder="成品名（留空自动）" style="flex:1" />
  </div>
  <div class="row">
    <button id="autoGen" class="accent">▶ 生成贴合成片</button>
    <span id="autoStatus"></span>
  </div>
  <div id="autoResult"></div>
</div>

<div class="card">
  <h2>🃏 游戏卡片叠加（跟随段落）</h2>
  <div class="sub" style="margin:0 0 8px">
    在成片视频左上角叠加游戏信息卡片（白底半透明 + 红粉边框）。卡片数据来自已解析的 Excel；
    每张卡片填「开始/结束」时间（对应游戏段落）。若刚生成过"自动贴合成片"，可点「按段落自动排布」自动填入每段窗口。
  </div>
  <div class="row">
    <input type="text" id="cardVideo" placeholder="成片视频路径（可用上方自动贴合成片结果，或手动填）" style="flex:1" />
    <button id="cardUseAuto" class="ghost" title="把上方自动贴合成片结果填入视频路径并排布窗口">⏱️ 用上方成片</button>
  </div>
  <div class="row">
    <input type="text" id="cardOutDir" placeholder="输出目录（默认 E:/worddeepseek/videocut/product）" style="flex:1" />
    <input type="text" id="cardOutName" placeholder="输出名（留空自动）" style="flex:1" />
  </div>
  <div class="row">
    <button id="cardLoadExcel" class="ghost">📊 从已解析 Excel 载入卡片</button>
    <button id="cardAutoTime" class="ghost">⏱️ 按段落自动排布时间</button>
    <button id="cardGen" class="accent">▶ 生成带卡片视频</button>
    <span id="cardStatus"></span>
  </div>
  <div id="cardRows"></div>
  <div id="cardResult"></div>
</div>

<div class="card">
  <h2>🎬 剪辑拼接成片</h2>
  <div class="sub" style="margin:0 0 8px">
    从素材列表选择文件（可填起止时间，留空 = 从头/到结尾；格式如 <code>1:00</code> 或 <code>90</code>），
    用上下按钮调整顺序，点击「拼接成片」按顺序剪辑拼接，输出到成品目录。
    拼接为流拷贝无损模式，自动处理不同帧率的兼容问题。
  </div>
  <div class="row">
    <input type="text" id="matDir" title="素材目录" placeholder="素材目录（默认下载素材目录）" />
    <button id="matRefresh" class="ghost">🔄 载入素材</button>
    <button id="matAddRow" class="ghost">＋ 手动添加素材</button>
  </div>
  <div id="composeRows"></div>
  <div class="row">
    <input type="text" id="prodDir" title="成品目录" placeholder="成品目录（默认 E:/worddeepseek/videocut/product）" />
    <input type="text" id="prodName" title="成品名（留空自动：日期_游戏名1_游戏名2…）" placeholder="成品名（留空自动生成）" />
  </div>
  <div class="row">
    <button id="composeBtn" class="accent">▶ 拼接成片</button>
    <button id="openProd" class="ghost">📂 打开成品文件夹</button>
    <button id="refreshProd" class="ghost">🔄 刷新成品列表</button>
    <span id="composeStatus"></span>
  </div>
  <div id="composeResult"></div>
  <div class="files" id="prodFiles"><div class="empty">（暂无成品）</div></div>
</div>

<script>
var ta = document.getElementById('links');
var dirInput = document.getElementById('dir');
var qs = document.getElementById('quality');
var skipChk = document.getElementById('skip');
var engineInfo = document.getElementById('engineInfo');
var btnStart = document.getElementById('start');
var btnCancel = document.getElementById('cancel');
var btnOpen = document.getElementById('openDir');
var btnRefresh = document.getElementById('refresh');
var statusEl = document.getElementById('status');
var previewBox = document.getElementById('preview');
var previewBody = document.getElementById('previewBody');
var jobBox = document.getElementById('jobBox');
var itemsEl = document.getElementById('items');
var sumEl = document.getElementById('sum');
var jobDirEl = document.getElementById('jobDir');
var jobStateEl = document.getElementById('jobState');
var filesEl = document.getElementById('files');

var curJob = null;

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function setStatus(t) { statusEl.textContent = t || ''; }
function parseLines() {
  return ta.value.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean).map(function(line){
    var m = line.match(/app\/(\d+)/i);
    var appid = m ? m[1] : (/^\d{1,10}$/.test(line) ? line : null);
    return { line: line, appid: appid };
  });
}
function updatePreview() {
  var rows = parseLines();
  if (!rows.length) { previewBox.style.display = 'none'; return; }
  var seen = {}; var html = ''; var ok = 0;
  rows.forEach(function(r){
    if (r.appid && !seen[r.appid]) { seen[r.appid] = 1; ok++; }
  });
  html += '<div class="meta">共 ' + rows.length + ' 行，识别出 ' + ok + ' 个不重复游戏：</div>';
  html += '<div class="meta">' + rows.map(function(r){
    return (r.appid ? '✅ appid ' + esc(r.appid) : '⚠️ 无效：' + esc(r.line));
  }).join('　') + '</div>';
  previewBody.innerHTML = html;
  previewBox.style.display = 'block';
}

function stateClass(s) {
  if (s === '下载中' || s === '获取游戏信息') return 'dl';
  if (s === '完成') return 'ok';
  if (s === '失败' || s === '无效链接') return 'err';
  if (s === '已存在') return 'skip';
  if (s === '已取消') return 'cancel';
  return 'pending';
}

function renderJob(job) {
  curJob = job;
  jobBox.style.display = 'block';
  jobDirEl.textContent = '→ ' + job.dir;
  jobStateEl.textContent = job.status === 'running' ? '（进行中）' : (job.status === 'done' ? '（已完成）' : (job.status === 'canceled' ? '（已取消）' : '（出错）'));
  jobStateEl.style.color = job.status === 'done' ? '#1a7a3a' : (job.status === 'running' ? '#1a73e8' : '#b00020');

  var html = '';
  job.items.forEach(function(it){
    var stateHtml = '<span class="st ' + stateClass(it.state) + '">' + esc(it.state) + '</span>';
    var nm = it.name ? esc(it.name) : (it.appid ? 'App ' + esc(it.appid) : '未知游戏');
    var ap = it.appid ? '<span class="ap">appid ' + esc(it.appid) + '</span>' : '';
    html += '<div class="it"><div class="top"><div><span class="nm">' + nm + '</span>' + ap + '</div>' + stateHtml + '</div>';
    if (it.state === '下载中' || it.state === '完成' || it.state === '已存在') {
      var pct = it.percent || 0;
      var barCls = (it.state === '下载中' && !pct) ? 'bar indet' : 'bar';
      html += '<div class="track"><div class="' + barCls + '" style="width:' + (pct || (barCls.indexOf('indet') >= 0 ? '' : 0)) + '%"></div></div>';
      var meta = [];
      if (it.state === '下载中') meta.push((pct ? pct + '%' : '…') + (it.speed ? '　' + esc(it.speed) : ''));
      if (it.size) meta.push(esc(formatSizeClient(it.size)));
      if (it.videoLabel) meta.push('视频源：' + esc(it.videoLabel) + (it.videoKind === 'direct' ? '' : '（N_m3u8DL-CLI 下载合并）'));
      if (it.path) meta.push(esc(it.path));
      if (meta.length) html += '<div class="meta">' + meta.join('<br>') + '</div>';
    }
    if (it.log && it.log.length && it.state === '下载中') {
      html += '<div class="logline">' + esc(it.log.join('\n')) + '</div>';
    }
    if (it.error) html += '<div class="errmsg">' + esc(it.error) + '</div>';
    html += '</div>';
  });
  itemsEl.innerHTML = html;

  if (job.status !== 'running') {
    var ok = job.items.filter(function(i){ return i.state === '完成' || i.state === '已存在'; }).length;
    var fail = job.items.filter(function(i){ return i.state === '失败' || i.state === '无效链接'; }).length;
    sumEl.textContent = '✅ 成功 ' + ok + ' 个　⚠️ 失败 ' + fail + ' 个　📁 素材目录：' + job.dir;
    btnCancel.disabled = true;
    btnStart.disabled = false;
    setStatus('');
    refreshFiles();
  } else {
    btnCancel.disabled = false;
    btnStart.disabled = true;
  }
}

function formatSizeClient(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

function connect(jobId) {
  if (window.__es) { window.__es.close(); window.__es = null; }
  var es = new EventSource('/api/events?jobId=' + encodeURIComponent(jobId));
  window.__es = es;
  es.onmessage = function(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'snapshot') renderJob(msg.job);
  };
  es.onerror = function() {
    if (curJob && curJob.status !== 'running' && window.__es) { window.__es.close(); window.__es = null; }
  };
}

function start() {
  var rows = parseLines();
  if (!rows.length) { setStatus('请先粘贴 Steam 链接'); return; }
  var links = rows.map(function(r){ return r.line; });
  var dir = dirInput.value.trim() || '';
  btnStart.disabled = true;
  setStatus('正在创建任务……');
  fetch('/api/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: links, dir: dir, skipExisting: skipChk.checked, quality: qs.value })
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { setStatus('启动失败：' + res.error); btnStart.disabled = false; return; }
      setStatus('任务已启动……');
      connect(res.jobId);
    })
    .catch(function(e){ setStatus('启动失败：' + e.message); btnStart.disabled = false; });
}

function cancel() {
  if (!curJob) return;
  fetch('/api/cancel?jobId=' + encodeURIComponent(curJob.id)).then(function(r){ return r.json(); }).then(function(res){
    if (res.error) setStatus('取消失败：' + res.error);
  }).catch(function(e){ setStatus('取消失败：' + e.message); });
}

function refreshFiles() {
  var dir = dirInput.value.trim() || 'default';
  fetch('/api/files?dir=' + encodeURIComponent(dir))
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { filesEl.innerHTML = '<div class="empty">' + esc(res.error) + '</div>'; return; }
      if (!res.files.length) { filesEl.innerHTML = '<div class="empty">该目录下还没有视频文件</div>'; return; }
      var html = '';
      res.files.forEach(function(f){
        html += '<div class="file"><span class="fn">🎬 ' + esc(f.name) + '</span><span class="sz">' + formatSizeClient(f.size) + '</span></div>';
      });
      filesEl.innerHTML = html;
    })
    .catch(function(e){ filesEl.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>'; });
}

function openDir() {
  var dir = dirInput.value.trim() || '';
  fetch('/api/open-folder?dir=' + encodeURIComponent(dir))
    .then(function(r){ return r.json(); })
    .then(function(res){ if (res.error) setStatus(res.error); else setStatus('已打开文件夹'); })
    .catch(function(e){ setStatus('打开失败：' + e.message); });
}

// 加载配置（默认目录 + 内置引擎状态）
fetch('/api/config').then(function(r){ return r.json(); }).then(function(res){
  if (!dirInput.value.trim()) dirInput.value = res.dir;
  var parts = [];
  if (res.ffmpeg && res.builtin) parts.push('✅ HLS 解析下载已内置（Node），合并引擎：内置 ffmpeg');
  else if (res.ffmpeg) parts.push('✅ HLS 解析下载已内置（Node），合并引擎：系统 ffmpeg');
  else parts.push('⚠️ 未找到 ffmpeg（下载合并将不可用）');
  if (res.asrAvailable) parts.push('🎙️ ' + res.asrDetail);
  else parts.push('🎙️ ⚠️ ' + res.asrDetail);
  engineInfo.textContent = parts.join('　|　');
  refreshFiles();
}).catch(function(){});

btnStart.addEventListener('click', start);
btnCancel.addEventListener('click', cancel);
btnOpen.addEventListener('click', openDir);
btnRefresh.addEventListener('click', refreshFiles);
ta.addEventListener('input', updatePreview);
dirInput.addEventListener('change', refreshFiles);
updatePreview();

// ===== 配音上传（01/02/03… 按序） =====
var voiceDirInput = document.getElementById('voiceDir');
var voiceStatusEl = document.getElementById('voiceStatus');
var voiceUploadListEl = document.getElementById('voiceUploadList');
var voiceFilesEl = document.getElementById('voiceFiles');
var voiceFileInput = document.getElementById('voiceFileInput');
var voiceFiles = []; // 已上传列表

function vStatus(t) { voiceStatusEl.textContent = t || ''; }
function voiceDirVal() { return voiceDirInput.value.trim() || ''; }
function isVoiceExt(name) { return /\.(mp3|wav|m4a|aac|flac|ogg|wma|opus)$/i.test(name); }

function loadVoiceFiles() {
  fetch('/api/voice/list?dir=' + encodeURIComponent(voiceDirVal()))
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { voiceFilesEl.innerHTML = '<div class="empty">' + esc(res.error) + '</div>'; return; }
      if (!voiceDirInput.value.trim()) voiceDirInput.value = res.dir;
      voiceFiles = res.files;
      fillSubVoiceSel();
      if (!voiceFiles.length) { voiceFilesEl.innerHTML = '<div class="empty">（暂无配音，先上传）</div>'; return; }
      var html = '';
      voiceFiles.forEach(function(f, i) {
        html += '<div class="file"><span class="fn">' + '#' + (i + 1) + '　🎙️ ' + esc(f.name) + '</span><span class="sz">' + formatSizeClient(f.size) + '　<button class="danger" style="padding:2px 8px" onclick="deleteVoiceFile(' + i + ')">删除</button></span></div>';
      });
      voiceFilesEl.innerHTML = html;
    })
    .catch(function(e){ voiceFilesEl.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>'; });
}

// ===== 文案 → 字幕 =====
var subVoiceSel = document.getElementById('subVoiceSel');
var subScriptEl = document.getElementById('subScript');
var subStatusEl = document.getElementById('subStatus');
var subResultEl = document.getElementById('subResult');
var subGenBtn = document.getElementById('subGen');
var subCopyBtn = document.getElementById('subCopy');
var lastSrt = '';

function fillSubVoiceSel() {
  if (!subVoiceSel) return;
  var cur = subVoiceSel.value;
  subVoiceSel.innerHTML = '';
  if (!voiceFiles.length) {
    subVoiceSel.innerHTML = '<option value="">（请先上传配音）</option>';
    return;
  }
  voiceFiles.forEach(function(f, i) {
    var opt = document.createElement('option');
    opt.value = f.name;
    opt.textContent = '#' + (i + 1) + ' ' + f.name;
    subVoiceSel.appendChild(opt);
  });
  if (cur) subVoiceSel.value = cur;
}
function subStatus(t) { if (subStatusEl) subStatusEl.textContent = t || ''; }

document.getElementById('subPickTxt').addEventListener('click', function(){ document.getElementById('subTxtInput').click(); });
document.getElementById('subTxtInput').addEventListener('change', function(ev){
  var f = ev.target.files && ev.target.files[0];
  if (!f) return;
  var rd = new FileReader();
  rd.onload = function(){ subScriptEl.value = rd.result; subStatus('已载入文案文件：' + f.name); };
  rd.readAsText(f);
  ev.target.value = '';
});

subGenBtn.addEventListener('click', function(){
  var voiceFile = subVoiceSel.value;
  var script = subScriptEl.value.trim();
  if (!voiceFile) { subStatus('请先选择配音'); return; }
  if (!script) { subStatus('请粘贴文案内容'); return; }
  subGenBtn.disabled = true;
  subStatus('识别中……（配音时长 1 倍约 1~3 倍耗时，请稍候）');
  subResultEl.innerHTML = '';
  fetch('/api/subtitle/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voiceFile: voiceFile, script: script, voiceDir: voiceDirVal(), outDir: document.getElementById('subOutDir').value.trim() })
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      subGenBtn.disabled = false;
      if (res.error) { subStatus('生成失败'); subResultEl.innerHTML = '<div class="errmsg">' + esc(res.error) + '</div>'; return; }
      lastSrt = res.srt;
      subStatus('完成 ✓');
      var html = '<div class="meta" style="color:#1a7a3a;margin-top:6px">✅ 字幕已保存：<b>' + esc(res.srtFile) + '</b>（共 ' + res.cues.length + ' 句）</div>';
      html += '<pre style="white-space:pre-wrap;max-height:260px;overflow:auto">' + esc(res.srt) + '</pre>';
      subResultEl.innerHTML = html;
      subCopyBtn.style.display = 'inline-block';
    })
    .catch(function(e){ subGenBtn.disabled = false; subStatus('生成失败'); subResultEl.innerHTML = '<div class="errmsg">请求失败：' + esc(e.message) + '</div>'; });
});

subCopyBtn.addEventListener('click', function(){
  if (!lastSrt) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(lastSrt).then(function(){ subStatus('已复制到剪贴板'); });
  } else {
    window.prompt('请手动复制（Ctrl+C）：', lastSrt);
  }
});

// ===== Excel 游戏数据（A3） =====
var excelDirInput = document.getElementById('excelDir');
var excelStatusEl = document.getElementById('excelStatus');
var excelInfoEl = document.getElementById('excelInfo');
var excelPreviewEl = document.getElementById('excelPreview');
var excelSheetSel = document.getElementById('excelSheet');
var excelFileInput = document.getElementById('excelFile');
var lastExcelFile = '';
window.__excelData = null; // { file, sheet, cols, rows, total } 供后续卡片使用

function eStatus(t) { excelStatusEl.textContent = t || ''; }
function excelDirVal() { return excelDirInput.value.trim() || ''; }

document.getElementById('excelPick').addEventListener('click', function(){ excelFileInput.click(); });
excelFileInput.addEventListener('change', function(){
  var f = excelFileInput.files && excelFileInput.files[0];
  if (!f) return;
  if (!/\.xlsx$/i.test(f.name)) { eStatus('仅支持 .xlsx'); return; }
  eStatus('上传中……');
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/excel/upload?name=' + encodeURIComponent(f.name) + '&dir=' + encodeURIComponent(excelDirVal()));
  xhr.onload = function(){
    var res;
    try { res = JSON.parse(xhr.responseText); } catch (e) { res = { error: '响应异常' }; }
    if (xhr.status === 200 && res.ok) {
      lastExcelFile = f.name;
      excelSheetSel.innerHTML = '';
      (res.sheets || []).forEach(function(s, i){
        var opt = document.createElement('option');
        opt.value = s.name;
        opt.textContent = s.name;
        excelSheetSel.appendChild(opt);
      });
      eStatus('上传成功：' + f.name + '（' + (res.sheets || []).length + ' 个工作表）');
      loadExcelPreview();
    } else {
      eStatus('上传失败');
      excelInfoEl.innerHTML = '<div class="errmsg">' + esc(res.error || '未知错误') + '</div>';
    }
  };
  xhr.onerror = function(){ eStatus('上传失败：网络错误'); };
  xhr.send(f);
  excelFileInput.value = '';
});
excelSheetSel.addEventListener('change', loadExcelPreview);
document.getElementById('excelLoad').addEventListener('click', loadExcelPreview);

function loadExcelPreview() {
  if (!lastExcelFile) { eStatus('请先上传 xlsx'); return; }
  var sheet = excelSheetSel.value || '';
  eStatus('解析中……');
  fetch('/api/excel/preview?file=' + encodeURIComponent(lastExcelFile) + '&sheet=' + encodeURIComponent(sheet) + '&dir=' + encodeURIComponent(excelDirVal()))
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { eStatus('解析失败'); excelInfoEl.innerHTML = '<div class="errmsg">' + esc(res.error) + '</div>'; return; }
      window.__excelData = { file: lastExcelFile, sheet: res.sheet, cols: res.cols, rows: res.rows, total: res.total };
      var colNames = { name: '游戏名', price: '原价', now: '现价', rating: '好评率', discount: '折扣力度', deadline: '截止日期', tag1: '标签1', tag2: '标签2' };
      var mapped = Object.keys(colNames).filter(function(k){ return res.cols[k] !== undefined; }).map(function(k){ return colNames[k] + '←列' + (res.cols[k] + 1); });
      excelInfoEl.innerHTML = '<div class="meta" style="margin-top:6px">✅ 工作表「' + esc(res.sheet) + '」共解析 <b>' + res.total + '</b> 行' + (mapped.length ? '　字段映射：' + esc(mapped.join('，')) : '') + '</div>';
      eStatus('解析完成 ✓');
      // 预览表（前 50 行，按映射字段展示）
      if (!res.rows.length) { excelPreviewEl.innerHTML = '<div class="empty">（无数据行）</div>'; return; }
      var fOrder = ['name', 'price', 'now', 'rating', 'discount', 'deadline', 'tag1', 'tag2'];
      var fLabels = { name: '游戏名', price: '原价', now: '现价', rating: '好评率', discount: '折扣力度', deadline: '截止日期', tag1: '标签1', tag2: '标签2' };
      var html = '<table style="border-collapse:collapse;font-size:12px;margin-top:8px;width:100%"><tr><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">#</th>';
      fOrder.forEach(function(f){ html += '<th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">' + fLabels[f] + '</th>'; });
      html += '</tr>';
      res.rows.forEach(function(row, i){
        html += '<tr><td style="border:1px solid #888;padding:3px 8px">' + (i + 1) + '</td>';
        fOrder.forEach(function(f){ html += '<td style="border:1px solid #888;padding:3px 8px">' + esc(row[f] || '') + '</td>'; });
        html += '</tr>';
      });
      html += '</table>';
      excelPreviewEl.innerHTML = html;
    })
    .catch(function(e){ eStatus('解析失败'); excelInfoEl.innerHTML = '<div class="errmsg">请求失败：' + esc(e.message) + '</div>'; });
}

function deleteVoiceFile(i) {
  var f = voiceFiles[i];
  if (!f) return;
  if (!window.confirm('删除配音：' + f.name + '？')) return;
  fetch('/api/voice/delete?name=' + encodeURIComponent(f.name) + '&dir=' + encodeURIComponent(voiceDirVal()))
    .then(function(r){ return r.json(); })
    .then(function(res){ if (res.error) vStatus(res.error); else { vStatus('已删除 ' + f.name); loadVoiceFiles(); } })
    .catch(function(e){ vStatus('删除失败：' + e.message); });
}

function uploadVoiceFiles(fileList) {
  var files = Array.prototype.slice.call(fileList || []).filter(function(f){ return isVoiceExt(f.name); });
  var bad = (fileList ? fileList.length : 0) - files.length;
  if (!files.length) { vStatus('没有可上传的音频文件（支持 mp3/wav/m4a/aac/flac/ogg/wma/opus）'); return; }
  var dir = voiceDirVal();
  var html = '';
  var items = files.map(function(f){
    return { f: f, state: '排队', pct: 0 };
  });
  items.forEach(function(it){
    html += '<div class="file"><span class="fn">' + esc(it.f.name) + '</span><span class="sz" data-sz>排队中</span></div>';
  });
  voiceUploadListEl.innerHTML = html;
  if (bad) vStatus('已跳过 ' + bad + ' 个非音频文件');
  else vStatus('开始上传 ' + items.length + ' 个文件……');

  var els = voiceUploadListEl.querySelectorAll('.file');
  var run = function(it, idx) {
    var el = els[idx];
    var szEl = el.querySelector('[data-sz]');
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/voice/upload?name=' + encodeURIComponent(it.f.name) + '&dir=' + encodeURIComponent(dir));
    xhr.upload.onprogress = function(ev) {
      if (ev.lengthComputable) {
        it.pct = Math.round((ev.loaded / ev.total) * 100);
        szEl.textContent = it.pct + '%';
      }
    };
    xhr.onload = function() {
      var res;
      try { res = JSON.parse(xhr.responseText); } catch (e) { res = { error: '响应异常' }; }
      if (xhr.status === 200 && res.ok) { it.state = '完成'; szEl.textContent = '✅ ' + formatSizeClient(res.size); }
      else { it.state = '失败'; szEl.textContent = '❌ ' + (res.error || '上传失败'); }
    };
    xhr.onerror = function() { it.state = '失败'; szEl.textContent = '❌ 网络错误'; };
    xhr.send(it.f);
  };
  // 并发 3 个上传
  var idx = 0;
  var workers = [];
  for (var w = 0; w < 3 && w < items.length; w++) {
    workers.push((function(){ return new Promise(function(done){
      var next = function(){
        if (idx >= items.length) { done(); return; }
        var i = idx++;
        var it = items[i];
        run(it, i);
        // 轮询该项完成（XHR 无 Promise，用 setInterval 判断）
        var timer = setInterval(function(){
          if (it.state === '完成' || it.state === '失败') { clearInterval(timer); next(); }
        }, 200);
      };
      next();
    }); })());
  }
  Promise.all(workers).then(function(){
    var done = items.filter(function(it){ return it.state === '完成'; }).length;
    vStatus('上传完成：成功 ' + done + '/' + items.length);
    loadVoiceFiles();
    setTimeout(function(){ voiceUploadListEl.innerHTML = ''; }, 3000);
  });
}

document.getElementById('voicePick').addEventListener('click', function(){ voiceFileInput.click(); });
voiceFileInput.addEventListener('change', function(){ uploadVoiceFiles(voiceFileInput.files); voiceFileInput.value = ''; });
document.getElementById('voiceRefresh').addEventListener('click', loadVoiceFiles);
document.getElementById('voiceClear').addEventListener('click', function(){
  if (!voiceFiles.length) { vStatus('列表已是空的'); return; }
  if (!window.confirm('清空列表（不删除文件）？')) return;
  voiceFiles = [];
  voiceFilesEl.innerHTML = '<div class="empty">（暂无配音）</div>';
  vStatus('');
});
// 拖拽上传
var voiceCard = document.getElementById('voiceDir');
voiceDirInput.parentElement.parentElement.addEventListener('dragover', function(e){ e.preventDefault(); });
voiceDirInput.parentElement.parentElement.addEventListener('drop', function(e){
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files) uploadVoiceFiles(e.dataTransfer.files);
});
voiceDirInput.addEventListener('change', loadVoiceFiles);
loadVoiceFiles();

// ===== 数据来源切换（Excel / Steam 直抓） =====
var srcExcelBox = document.getElementById('srcExcelBox');
var srcSteamBox = document.getElementById('srcSteamBox');
var steamLinksEl = document.getElementById('steamLinks');
var steamStatusEl = document.getElementById('steamStatus');

function setDataSource(mode) {
  if (mode === 'steam') {
    srcExcelBox.style.display = 'none';
    srcSteamBox.style.display = 'block';
  } else {
    srcExcelBox.style.display = 'block';
    srcSteamBox.style.display = 'none';
  }
}
document.getElementById('srcExcelBtn').addEventListener('click', function(){ setDataSource('excel'); });
document.getElementById('srcSteamBtn').addEventListener('click', function(){ setDataSource('steam'); });

document.getElementById('steamFetch').addEventListener('click', function(){
  var text = steamLinksEl.value.trim();
  if (!text) { steamStatusEl.textContent = '请粘贴 Steam 链接'; return; }
  var links = text.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
  var btn = document.getElementById('steamFetch');
  btn.disabled = true;
  steamStatusEl.textContent = '抓取中（每个游戏约需 2~6 秒）……';
  excelInfoEl.innerHTML = '';
  excelPreviewEl.innerHTML = '';
  fetch('/api/steam/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ links: links })
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      btn.disabled = false;
      if (res.error) { steamStatusEl.textContent = '抓取失败：' + res.error; return; }
      var okRows = (res.rows || []).filter(function(rw){ return !rw.error; });
      window.__excelData = { file: 'steam', sheet: 'steam', cols: {}, rows: okRows, total: okRows.length };
      steamStatusEl.textContent = '抓取完成：成功 ' + okRows.length + ' 个' + (res.errs && res.errs.length ? '，失败 ' + res.errs.length + ' 个' : '');
      renderSteamRows(okRows);
    })
    .catch(function(e){ btn.disabled = false; steamStatusEl.textContent = '抓取失败：' + e.message; });
});

function renderSteamRows(rows) {
  var bad = (rows || []).filter(function(r){ return r.error; });
  var good = (rows || []).filter(function(r){ return !r.error; });
  var html = '<div class="meta" style="margin-top:6px">共抓取 ' + good.length + ' 条' + (bad.length ? '，其中 ' + bad.length + ' 条失败' : '') + '</div>';
  if (bad.length) {
    bad.forEach(function(r){ html += '<div class="errmsg">appid ' + esc(r.appid) + '：' + esc(r.error) + '</div>'; });
  }
  if (good.length) {
    html += '<table style="border-collapse:collapse;font-size:12px;margin-top:8px;width:100%"><tr><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">#</th><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">游戏名</th><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">原/现</th><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">折扣</th><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">好评率</th><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">截止</th><th style="border:1px solid #888;padding:4px 8px;background:rgba(127,127,127,.15)">标签</th></tr>';
    good.forEach(function(r, i) {
      var rating = r.rating ? (Number(r.rating) <= 1 ? (Number(r.rating) * 100).toFixed(0) + '%' : r.rating) : '-';
      html += '<tr><td style="border:1px solid #888;padding:3px 8px">' + (i + 1) + '</td>';
      html += '<td style="border:1px solid #888;padding:3px 8px">' + esc(r.name) + '</td>';
      html += '<td style="border:1px solid #888;padding:3px 8px">' + esc([r.price, r.now].filter(Boolean).join(' → ')) + '</td>';
      html += '<td style="border:1px solid #888;padding:3px 8px">' + esc(r.discount || '-') + '</td>';
      html += '<td style="border:1px solid #888;padding:3px 8px">' + esc(rating) + '</td>';
      html += '<td style="border:1px solid #888;padding:3px 8px">' + esc(r.deadline || '-') + '</td>';
      html += '<td style="border:1px solid #888;padding:3px 8px">' + esc([r.tag1, r.tag2].filter(Boolean).join(' ')) + '</td></tr>';
    });
    html += '</table>';
  }
  excelPreviewEl.innerHTML = html;
  excelInfoEl.innerHTML = '<div class="meta" style="margin-top:6px">✅ 已抓取 ' + good.length + ' 条游戏数据（顺序=链接顺序）。可到「🃏 游戏卡片叠加」载入使用</div>';
}

// ===== 自动贴合成片（A4） =====
var autoMatDirInput = document.getElementById('autoMatDir');
var autoVoiceDirInput = document.getElementById('autoVoiceDir');
var autoPaddingInput = document.getElementById('autoPadding');
var autoOutDirInput = document.getElementById('autoOutDir');
var autoOutNameInput = document.getElementById('autoOutName');
var autoRowsEl = document.getElementById('autoRows');
var autoPairInfoEl = document.getElementById('autoPairInfo');
var autoStatusEl = document.getElementById('autoStatus');
var autoResultEl = document.getElementById('autoResult');
var autoGenBtn = document.getElementById('autoGen');
var autoMats = [];   // { path, name, start }
var autoVoices = []; // { path, name }

function aStatus(t) { autoStatusEl.textContent = t || ''; }

function loadAutoMats() {
  var dir = autoMatDirInput.value.trim() || '';
  fetch('/api/materials?dir=' + encodeURIComponent(dir))
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { aStatus(res.error); return; }
      if (!autoMatDirInput.value.trim()) autoMatDirInput.value = res.dir;
      autoMats = res.files.map(function(f){ return { path: f.path, name: f.gameName || f.name, start: '' }; });
      renderAutoRows();
      updateAutoPair();
      aStatus('已载入 ' + autoMats.length + ' 个素材');
    })
    .catch(function(e){ aStatus('载入失败：' + e.message); });
}
function loadAutoVoices() {
  var dir = autoVoiceDirInput.value.trim() || '';
  fetch('/api/voice/list?dir=' + encodeURIComponent(dir))
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { aStatus(res.error); return; }
      if (!autoVoiceDirInput.value.trim()) autoVoiceDirInput.value = res.dir;
      autoVoices = res.files.map(function(f){ return { path: f.path, name: f.name }; });
      renderAutoRows();
      updateAutoPair();
      aStatus('已载入 ' + autoVoices.length + ' 段配音');
    })
    .catch(function(e){ aStatus('载入失败：' + e.message); });
}
document.getElementById('autoLoadMat').addEventListener('click', loadAutoMats);
document.getElementById('autoLoadVoice').addEventListener('click', loadAutoVoices);

function renderAutoRows() {
  if (!autoMats.length && !autoVoices.length) {
    autoRowsEl.innerHTML = '<div class="empty">先分别载入素材与配音（按顺序一一对应：素材1↔配音1）</div>';
    return;
  }
  var n = Math.max(autoMats.length, autoVoices.length);
  var html = '';
  for (var i = 0; i < n; i++) {
    var m = autoMats[i];
    var v = autoVoices[i];
    html += '<div class="it"><div class="top" style="align-items:center">';
    if (m) {
      html += '<span style="flex:1"><b>#' + (i + 1) + ' 素材</b> ' + esc(m.name || m.path) + '</span>';
      html += '<input type="text" data-ai="' + i + '" value="' + esc(m.start) + '" placeholder="起点(0)" title="素材起点(秒)" style="width:80px" />';
    } else {
      html += '<span style="flex:1;color:#b00020">#' + (i + 1) + ' 缺素材</span><span style="width:80px"></span>';
    }
    html += '<span style="padding:0 6px">↔</span>';
    if (v) html += '<span style="flex:1">🎙️ ' + esc(v.name) + '</span>';
    else html += '<span style="flex:1;color:#b00020">缺配音</span>';
    html += '</div></div>';
  }
  autoRowsEl.innerHTML = html;
  autoRowsEl.querySelectorAll('input[data-ai]').forEach(function(inp){
    inp.addEventListener('input', function(){
      var idx = Number(inp.getAttribute('data-ai'));
      if (autoMats[idx]) autoMats[idx].start = inp.value;
    });
  });
}
function updateAutoPair() {
  if (!autoMats.length || !autoVoices.length) { autoPairInfoEl.textContent = ''; return; }
  if (autoMats.length === autoVoices.length) autoPairInfoEl.textContent = '✅ 素材与配音数量一致（' + autoMats.length + ' 对），可生成。每段画面 = 配音时长 + 余量。';
  else autoPairInfoEl.textContent = '⚠️ 素材(' + autoMats.length + ') 与配音(' + autoVoices.length + ') 数量不一致，顺序即配对，请调整。';
}

autoGenBtn.addEventListener('click', function(){
  if (!autoMats.length || !autoVoices.length) { aStatus('请先载入素材与配音'); return; }
  if (autoMats.length !== autoVoices.length) { aStatus('素材与配音数量不一致'); return; }
  var payload = {
    materials: autoMats.map(function(m){ return { path: m.path, start: m.start || 0 }; }),
    voices: autoVoices.map(function(v){ return { path: v.path }; }),
    padding: Number(autoPaddingInput.value) || 2,
    transition: Number(document.getElementById('autoTransition').value) || 0,
    outDir: autoOutDirInput.value.trim(),
    outName: autoOutNameInput.value.trim()
  };
  autoGenBtn.disabled = true;
  aStatus('处理中（读时长 → 剪切 → 拼接 → 贴音轨），配音较长请稍候……');
  autoResultEl.innerHTML = '';
  fetch('/api/compose-auto', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      autoGenBtn.disabled = false;
      if (res.error) { aStatus('生成失败'); autoResultEl.innerHTML = '<div class="errmsg">' + esc(res.error) + '</div>'; return; }
      aStatus('完成 ✓');
      window.__autoResult = res; // 供"游戏卡片叠加"联动
      var html = '<div class="meta" style="color:#1a7a3a;margin-top:6px">✅ 成片已生成：<b>' + esc(res.output) + '</b>（' + formatSizeClient(res.size) + '，总时长约 ' + Math.round(res.duration) + ' 秒）</div>';
      (res.segments || []).forEach(function(s){
        html += '<div class="meta">段 ' + s.index + '：配音起点 ≈ ' + Math.round(s.delayMs / 1000) + 's（' + esc(s.voice) + '）</div>';
      });
      autoResultEl.innerHTML = html;
    })
    .catch(function(e){ autoGenBtn.disabled = false; aStatus('生成失败'); autoResultEl.innerHTML = '<div class="errmsg">请求失败：' + esc(e.message) + '</div>'; });
});

// ===== 游戏卡片叠加（C1） =====
var cardVideoInput = document.getElementById('cardVideo');
var cardOutDirInput = document.getElementById('cardOutDir');
var cardOutNameInput = document.getElementById('cardOutName');
var cardRowsEl = document.getElementById('cardRows');
var cardStatusEl = document.getElementById('cardStatus');
var cardResultEl = document.getElementById('cardResult');
var cardGenBtn = document.getElementById('cardGen');
var cardList = []; // { name, price, now, rating, discount, deadline, tag1, tag2, raw, start, end }
window.__autoResult = null;

function cStatus2(t) { cardStatusEl.textContent = t || ''; }

document.getElementById('cardLoadExcel').addEventListener('click', function(){
  var d = window.__excelData;
  if (!d || !d.rows || !d.rows.length) { cStatus2('请先在「📊 Excel 游戏数据」解析工作表'); return; }
  cardList = d.rows.map(function(r){ return { name: r.name, price: r.price, now: r.now, rating: r.rating, discount: r.discount, deadline: r.deadline, tag1: r.tag1, tag2: r.tag2, raw: r.raw || null, start: '', end: '' }; });
  renderCardRows();
  cStatus2('已载入 ' + cardList.length + ' 张卡片（来自 Excel）');
});

document.getElementById('cardUseAuto').addEventListener('click', function(){
  var ar = window.__autoResult;
  if (!ar || !ar.output) { cStatus2('请先生成自动贴合成片'); return; }
  cardVideoInput.value = ar.output;
  if (!cardOutDirInput.value.trim()) {
    cardOutDirInput.value = ar.output.replace(/[\\/][^\\/]+$/, '');
  }
  autoTimeCards(ar);
  cStatus2('已使用上方成片，并按段落排布卡片时间');
});

document.getElementById('cardAutoTime').addEventListener('click', function(){
  var ar = window.__autoResult;
  if (!ar || !ar.output) { cStatus2('请先生成自动贴合成片（需要段落时间）'); return; }
  autoTimeCards(ar);
});

function autoTimeCards(ar) {
  var segs = ar.segments || [];
  if (!segs.length) { cStatus2('成片结果缺少段落时间'); return; }
  cardList.forEach(function(card, i) {
    var s = segs[i];
    if (!s) return;
    var start = (s.delayMs || 0) / 1000;
    var end = i + 1 < segs.length ? (segs[i + 1].delayMs || 0) / 1000 : (ar.duration || start + 5);
    card.start = Math.round(start * 10) / 10;
    card.end = Math.round(end * 10) / 10;
  });
  renderCardRows();
}

function renderCardRows() {
  if (!cardList.length) { cardRowsEl.innerHTML = '<div class="empty">卡片为空：点「从已解析 Excel 载入卡片」</div>'; return; }
  var html = '';
  cardList.forEach(function(c, i) {
    html += '<div class="it"><div class="top" style="align-items:center">';
    html += '<span style="flex:1"><b>#' + (i + 1) + '</b> ' + esc(c.name || '(未命名)') + '</span>';
    html += '<input type="text" data-ck="start" data-ci="' + i + '" value="' + esc(c.start) + '" placeholder="开始" style="width:80px" title="显示开始(秒)" />';
    html += '<input type="text" data-ck="end" data-ci="' + i + '" value="' + esc(c.end) + '" placeholder="结束" style="width:80px" title="显示结束(秒)" />';
    html += '<button class="danger" style="padding:3px 9px" onclick="removeCardRow(' + i + ')">×</button>';
    html += '</div></div>';
  });
  cardRowsEl.innerHTML = html;
  cardRowsEl.querySelectorAll('input[data-ck]').forEach(function(inp){
    inp.addEventListener('input', function(){
      var i = Number(inp.getAttribute('data-ci'));
      if (cardList[i]) cardList[i][inp.getAttribute('data-ck')] = inp.value;
    });
  });
}
function removeCardRow(i) { cardList.splice(i, 1); renderCardRows(); }

cardGenBtn.addEventListener('click', function(){
  var video = cardVideoInput.value.trim();
  if (!video) { cStatus2('请填写成片视频路径'); return; }
  var cards = cardList.filter(function(c){
    return c.start !== '' && c.end !== '' && (c.name || c.price);
  }).map(function(c){
    return { start: Number(c.start) || 0, end: Number(c.end) || 0, name: c.name, price: c.price, now: c.now, rating: c.rating, discount: c.discount, deadline: c.deadline, tag1: c.tag1, tag2: c.tag2, raw: c.raw };
  });
  if (!cards.length) { cStatus2('没有可用的卡片（请填开始/结束时间）'); return; }
  cardGenBtn.disabled = true;
  cStatus2('合成中（重编码叠加卡片，请稍候）……');
  cardResultEl.innerHTML = '';
  fetch('/api/cards-overlay', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: video, cards: cards, outDir: cardOutDirInput.value.trim(), outName: cardOutNameInput.value.trim() })
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      cardGenBtn.disabled = false;
      if (res.error) { cStatus2('生成失败'); cardResultEl.innerHTML = '<div class="errmsg">' + esc(res.error) + '</div>'; return; }
      cStatus2('完成 ✓');
      cardResultEl.innerHTML = '<div class="meta" style="color:#1a7a3a;margin-top:6px">✅ 已生成：<b>' + esc(res.output) + '</b>（' + formatSizeClient(res.size) + '，' + res.cards + ' 张卡片）</div>';
    })
    .catch(function(e){ cardGenBtn.disabled = false; cStatus2('生成失败'); cardResultEl.innerHTML = '<div class="errmsg">请求失败：' + esc(e.message) + '</div>'; });
});

// ===== 剪辑拼接成片 =====
var matDirInput = document.getElementById('matDir');
var prodDirInput = document.getElementById('prodDir');
var prodNameInput = document.getElementById('prodName');
var composeRowsEl = document.getElementById('composeRows');
var composeStatusEl = document.getElementById('composeStatus');
var composeResultEl = document.getElementById('composeResult');
var prodFilesEl = document.getElementById('prodFiles');
var composeBtn = document.getElementById('composeBtn');
var composeRows = [];

function cStatus(t) { composeStatusEl.textContent = t || ''; }

function addComposeRow(row) {
  composeRows.push({
    path: (row && row.path) || '',
    name: (row && row.name) || '',
    start: (row && row.start) || '',
    end: (row && row.end) || ''
  });
  renderCompose();
}
function removeComposeRow(i) { composeRows.splice(i, 1); renderCompose(); }
function moveComposeRow(i, d) {
  var j = i + d;
  if (j < 0 || j >= composeRows.length) return;
  var t = composeRows[i]; composeRows[i] = composeRows[j]; composeRows[j] = t;
  renderCompose();
}
function renderCompose() {
  if (!composeRows.length) {
    composeRowsEl.innerHTML = '<div class="empty">素材列表为空：点「载入素材」从素材目录载入，或「手动添加素材」。</div>';
    return;
  }
  var html = '';
  composeRows.forEach(function(r, i) {
    html += '<div class="it"><div class="top">';
    html += '<input type="text" data-i="' + i + '" data-f="name" value="' + esc(r.name) + '" placeholder="名称" style="flex:1;min-width:120px" />';
    html += '<button class="ghost" onclick="moveComposeRow(' + i + ',-1)" title="上移">↑</button>';
    html += '<button class="ghost" onclick="moveComposeRow(' + i + ',1)" title="下移">↓</button>';
    html += '<button class="danger" style="padding:6px 10px" onclick="removeComposeRow(' + i + ')" title="移除">×</button>';
    html += '</div><div class="top" style="margin-top:6px">';
    html += '<input type="text" data-i="' + i + '" data-f="start" value="' + esc(r.start) + '" placeholder="开始（留空=0）" style="width:130px" />';
    html += '<input type="text" data-i="' + i + '" data-f="end" value="' + esc(r.end) + '" placeholder="结束（留空=末尾）" style="width:130px" />';
    html += '</div><div class="meta">' + esc(r.path) + '</div></div>';
  });
  composeRowsEl.innerHTML = html;
  composeRowsEl.querySelectorAll('input').forEach(function(inp) {
    inp.addEventListener('input', function() {
      var idx = Number(inp.getAttribute('data-i'));
      var f = inp.getAttribute('data-f');
      if (composeRows[idx]) composeRows[idx][f] = inp.value;
    });
  });
}

function loadMaterials() {
  var dir = matDirInput.value.trim() || '';
  cStatus('正在载入素材……');
  fetch('/api/materials?dir=' + encodeURIComponent(dir))
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { cStatus(res.error); return; }
      if (!matDirInput.value.trim()) matDirInput.value = res.dir;
      var seen = {};
      res.files.forEach(function(f) {
        if (seen[f.path]) return;
        seen[f.path] = 1;
        composeRows.push({ path: f.path, name: f.gameName || '', start: '', end: '' });
      });
      renderCompose();
      cStatus('已载入 ' + res.files.length + ' 个素材');
    })
    .catch(function(e){ cStatus('载入失败：' + e.message); });
}

function compose() {
  if (!composeRows.length) { cStatus('素材列表为空'); return; }
  var materials = composeRows.map(function(r) {
    return { name: r.name, path: r.path, start: r.start, end: r.end };
  });
  var payload = {
    materials: materials,
    outDir: prodDirInput.value.trim(),
    outName: prodNameInput.value.trim()
  };
  composeBtn.disabled = true;
  cStatus('正在剪辑拼接（流拷贝无损，稍候）……');
  composeResultEl.innerHTML = '';
  fetch('/api/compose', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) {
        cStatus('拼接失败');
        composeResultEl.innerHTML = '<div class="errmsg">' + esc(res.error) + '</div>';
        return;
      }
      cStatus('完成 ✓');
      composeResultEl.innerHTML = '<div class="meta" style="color:#1a7a3a;margin-top:6px">✅ 成品已生成：<b>' + esc(res.output) + '</b>（' + formatSizeClient(res.size) + '）</div>';
      refreshProd();
    })
    .catch(function(e){
      cStatus('拼接失败');
      composeResultEl.innerHTML = '<div class="errmsg">请求失败：' + esc(e.message) + '</div>';
    })
    .finally(function(){ composeBtn.disabled = false; });
}

function refreshProd() {
  var dir = prodDirInput.value.trim() || 'default';
  fetch('/api/files?dir=' + encodeURIComponent(dir))
    .then(function(r){ return r.json(); })
    .then(function(res){
      if (res.error) { prodFilesEl.innerHTML = '<div class="empty">' + esc(res.error) + '</div>'; return; }
      if (!res.files.length) { prodFilesEl.innerHTML = '<div class="empty">该目录下还没有成品</div>'; return; }
      var html = '';
      res.files.forEach(function(f) {
        html += '<div class="file"><span class="fn">🎬 ' + esc(f.name) + '</span><span class="sz">' + formatSizeClient(f.size) + '</span></div>';
      });
      prodFilesEl.innerHTML = html;
    })
    .catch(function(e){ prodFilesEl.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>'; });
}

function openProd() {
  var dir = prodDirInput.value.trim() || '';
  fetch('/api/open-folder?dir=' + encodeURIComponent(dir))
    .then(function(r){ return r.json(); })
    .then(function(res){ if (res.error) cStatus(res.error); else cStatus('已打开成品文件夹'); })
    .catch(function(e){ cStatus('打开失败：' + e.message); });
}

document.getElementById('matRefresh').addEventListener('click', loadMaterials);
document.getElementById('matAddRow').addEventListener('click', function(){ addComposeRow({}); });
composeBtn.addEventListener('click', compose);
document.getElementById('openProd').addEventListener('click', openProd);
document.getElementById('refreshProd').addEventListener('click', refreshProd);
prodDirInput.addEventListener('change', refreshProd);
// 初始化：自动载入素材目录 + 成品列表
matDirInput.value = '';
prodDirInput.value = '';
loadMaterials();
refreshProd();
</script>
</body>
</html>`;

// ── HTTP 处理 ────────────────────────────────────────────────────────────────

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(text);
}

function html(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(PAGE),
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(PAGE);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// GET /api/config：返回默认目录与内置引擎状态。
function handleConfig(res) {
  const ff = resolveFfmpeg();
  const builtin = !!ff && ff.startsWith(path.join(SCRIPT_DIR, 'bin'));
  const asr = resolveSherpaOnnx();
  return json(res, 200, {
    dir: DEFAULT_DIR,
    voiceDir: DEFAULT_VOICE_DIR,
    ffmpeg: ff || '',
    builtin,
    asrAvailable: asr.available,
    asrDetail: asr.available ? '本地语音识别已就绪（sherpa-onnx + Whisper int8）' : '未安装语音识别引擎（字幕功能不可用：请从 Release 下载 sherpa-asr-win-x64.zip 解压到项目根目录）',
  });
}

// POST /api/download：创建下载任务。
async function handleDownload(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: '请求体不是合法 JSON' });
  }
  const links = (Array.isArray(payload.links) ? payload.links : []).map(String).filter((s) => s.trim());
  if (!links.length) return json(res, 400, { error: '请至少输入一个 Steam 链接或 appid' });
  const dir = String(payload.dir || '').trim() || DEFAULT_DIR;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return json(res, 400, { error: `无法创建下载目录：${e.message}` });
  }
  const job = createJob({
    links,
    dir,
    skipExisting: payload.skipExisting !== false,
    quality: payload.quality === '480' ? '480' : 'max',
  });
  jobs.set(job.id, job);
  runJob(job); // 异步执行，不阻塞响应
  return json(res, 200, { jobId: job.id, dir });
}

// GET /api/events?jobId=... ：SSE 进度推送。
function handleEvents(req, res, urlObj) {
  const jobId = urlObj.searchParams.get('jobId') || '';
  const job = jobs.get(jobId);
  if (!job) return json(res, 404, { error: '任务不存在' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ type: 'snapshot', job: jobView(job) })}\n\n`);
  job.listeners.add(res);
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }, 15000);
  req.on('close', () => {
    clearInterval(hb);
    job.listeners.delete(res);
  });
}

// GET /api/job?jobId=... ：查询任务快照（页面刷新后恢复用）。
function handleJob(urlObj, res) {
  const job = jobs.get(urlObj.searchParams.get('jobId') || '');
  if (!job) return json(res, 404, { error: '任务不存在' });
  return json(res, 200, { job: jobView(job) });
}

// POST /api/cancel?jobId=... ：取消任务。
function handleCancel(urlObj, res) {
  const ok = cancelJob(urlObj.searchParams.get('jobId') || '');
  return json(res, ok ? 200 : 404, ok ? { canceled: true } : { error: '任务不存在' });
}

// GET /api/files?dir=... ：列出下载目录里的文件。
function handleFiles(urlObj, res) {
  const dir = urlObj.searchParams.get('dir') || DEFAULT_DIR;
  return json(res, 200, { dir, files: listFiles(dir) });
}

// GET /api/open-folder?dir=... ：在资源管理器中打开目录。
function handleOpenFolder(urlObj, res) {
  const dir = urlObj.searchParams.get('dir') || DEFAULT_DIR;
  if (!fs.existsSync(dir)) return json(res, 400, { error: '目录不存在：' + dir });
  try {
    const cp = spawn('explorer', [dir], { stdio: 'ignore', detached: true });
    cp.on('error', (e) => json(res, 500, { error: `打开失败：${e.message}` }));
    cp.unref();
    return json(res, 200, { ok: true, dir });
  } catch (e) {
    return json(res, 500, { error: `打开失败：${e.message}` });
  }
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────

// 自检模式：定位网络问题。
async function runTest() {
  const proxyRaw = resolveProxy();
  console.log('========== 网络自检 ==========');
  console.log('代理设置：', proxyRaw ? proxyRaw : '（未设置）');
  if (proxyRaw) {
    try {
      const p = parseProxy(proxyRaw);
      console.log(`代理解析：${p.kind}://${p.host}:${p.port}`);
    } catch (e) {
      console.log('代理解析失败：', e.message);
    }
  }
  console.log('ffmpeg：', resolveFfmpeg() || '（未找到）');
  console.log('-----------------------------------------');
  console.log('1) DNS 解析 store.steampowered.com ...');
  try {
    const addrs = await dns.promises.resolve4('store.steampowered.com');
    console.log('   IPv4 解析成功：', addrs.join(', '));
  } catch (e) {
    console.log('   DNS 解析失败：', e.message);
  }
  console.log('2) 连接 store.steampowered.com:443 ...');
  await new Promise((resolve) => {
    const sock = net.connect(443, 'store.steampowered.com');
    sock.setTimeout(10000);
    sock.once('connect', () => { console.log('   TCP 连接成功'); sock.destroy(); resolve(); });
    sock.once('timeout', () => { console.log('   TCP 连接超时（10s）'); sock.destroy(); resolve(); });
    sock.once('error', (e) => { console.log('   TCP 连接失败：', e.message); resolve(); });
  });
  console.log('3) 调用 appdetails 接口（appid 105600）...');
  try {
    const data = await fetchApp('105600');
    if (!data) console.log('   接口正常，但 appid 105600 未返回数据');
    else {
      const movies = Array.isArray(data.movies) ? data.movies : [];
      const src = movies[0] ? pickSource(movies[0], 'max') : null;
      console.log('   ✅ 成功！游戏名：', data.name, '| 视频数：', movies.length);
      console.log('   第一个视频源：', src ? `${src.kind} / ${src.label}` : '（无）');
      if (src) console.log('   URL：', src.url.slice(0, 120) + '...');
    }
  } catch (e) {
    console.log('   接口调用失败：', describeError(e));
  }
  console.log('==============================');
}

function main() {
  const cliArg = process.argv[2];
  if (cliArg === '--test' || cliArg === '-t') {
    runTest().catch((e) => console.error('自检出错：', e));
    return;
  }

  const proxyRaw = resolveProxy();
  const server = createServer((req, res) => {
    const urlObj = new URL(req.url, `http://localhost:${PORT}`);
    const p = urlObj.pathname;
    if (p === '/api/download' && req.method === 'POST') {
      handleDownload(req, res).catch((e) => json(res, 500, { error: e.message }));
    } else if (p === '/api/events') {
      handleEvents(req, res, urlObj);
    } else if (p === '/api/job') {
      handleJob(urlObj, res);
    } else if (p === '/api/cancel') {
      handleCancel(urlObj, res);
    } else if (p === '/api/files') {
      handleFiles(urlObj, res);
    } else if (p === '/api/materials') {
      handleMaterials(urlObj, res);
    } else if (p === '/api/voice/list') {
      handleVoiceList(urlObj, res);
    } else if (p === '/api/voice/upload') {
      handleVoiceUpload(req, res, urlObj);
    } else if (p === '/api/voice/delete') {
      handleVoiceDelete(urlObj, res);
    } else if (p === '/api/subtitle/generate' && req.method === 'POST') {
      handleSubtitleGenerate(req, res).catch((e) => json(res, 500, { error: e.message }));
    } else if (p === '/api/excel/upload') {
      handleExcelUpload(req, res, urlObj);
    } else if (p === '/api/excel/preview') {
      handleExcelPreview(urlObj, res);
    } else if (p === '/api/steam/cards' && req.method === 'POST') {
      handleSteamCards(req, res).catch((e) => json(res, 500, { error: e.message }));
    } else if (p === '/api/compose-auto' && req.method === 'POST') {
      handleComposeAuto(req, res).catch((e) => json(res, 500, { error: e.message }));
    } else if (p === '/api/cards-overlay' && req.method === 'POST') {
      handleCardsOverlay(req, res).catch((e) => json(res, 500, { error: e.message }));
    } else if (p === '/api/compose' && req.method === 'POST') {
      handleCompose(req, res).catch((e) => json(res, 500, { error: e.message }));
    } else if (p === '/api/open-folder') {
      handleOpenFolder(urlObj, res);
    } else if (p === '/api/config') {
      handleConfig(res);
    } else if (p === '/favicon.ico') {
      res.writeHead(204); res.end();
    } else {
      html(res);
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 被占用。请用环境变量 PORT 换一个端口，例如：set PORT=8899 && node steam-video-downloader.mjs`);
    } else {
      console.error('服务器启动失败：', e.message);
    }
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log(`🎬 Steam 游戏视频批量下载工具已启动：http://localhost:${PORT}`);
    console.log(`   视频默认保存目录：${DEFAULT_DIR}（网页里可改）`);
    console.log(`   内置引擎：HLS 解析下载（Node）+ ffmpeg 合并（${resolveFfmpeg() || '未找到 ffmpeg'}）`);
    console.log(`   语言=${LANG}，货币区域=${CC}`);
    if (proxyRaw) console.log(`   使用代理：${proxyRaw}`);
    else console.log('   未检测到代理。若访问 Steam 需要代理，请设置 HTTPS_PROXY 环境变量后重启。');
  });
}

// 若未以 --use-system-ca 启动，自动带该参数重启自身，解决中间人证书校验问题。
// 设 STEAM_NO_RELAUNCH=1 可关闭此行为；--insecure 也会跳过重启。
const hasSystemCA = process.execArgv.includes('--use-system-ca');
if (!INSECURE && !hasSystemCA && !process.env.STEAM_NO_RELAUNCH) {
  console.error('ℹ️  自动以 --use-system-ca 重启自身，信任 Windows 系统证书库（解决证书校验失败）……');
  const child = spawn(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], { stdio: 'inherit' });
  child.on('error', (e) => {
    console.error('自动重启失败：', e.message);
    console.error('可手动运行：node --use-system-ca ' + process.argv.slice(1).join(' '));
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  main();
}
