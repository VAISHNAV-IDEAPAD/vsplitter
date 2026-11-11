const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');

const PORT = 3456;
const BASE_DIR = __dirname;
const UPLOADS_DIR = path.join(BASE_DIR, 'uploads');
const OUTPUTS_DIR = path.join(BASE_DIR, 'outputs');
const PUBLIC_DIR = path.join(BASE_DIR, 'public');
const CLOUD_DB_PATH = path.join(BASE_DIR, 'cloud_db.json');

for (const dir of [UPLOADS_DIR, OUTPUTS_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadCloudDb() {
  try {
    if (fs.existsSync(CLOUD_DB_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CLOUD_DB_PATH, 'utf8'));
      return {
        projectsHistory: Array.isArray(parsed.projectsHistory) ? parsed.projectsHistory : [],
        playlists: Array.isArray(parsed.playlists) ? parsed.playlists : [],
        oauthConfig: parsed.oauthConfig || { facebookAppId: '', instagramAppId: '' }
      };
    }
  } catch (_) {}
  return {
    projectsHistory: [],
    playlists: [],
    oauthConfig: { facebookAppId: '', instagramAppId: '' }
  };
}

function saveCloudDb(db) {
  try {
    fs.writeFileSync(CLOUD_DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to save cloud_db.json:', err.message);
  }
}

// Store active and completed jobs in memory
const jobs = new Map();
// Store probed movies
const movies = new Map();

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function formatTimestampFFmpeg(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = (s % 60).toFixed(3);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(6, '0')}`;
}

// Probe movie metadata using ffprobe
function probeMovie(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];
    execFile('ffprobe', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        return reject(new Error(`ffprobe failed: ${stderr || err.message}`));
      }
      try {
        const data = JSON.parse(stdout);
        const videoStream = (data.streams || []).find(s => s.codec_type === 'video');
        const audioStreams = (data.streams || []).filter(s => s.codec_type === 'audio');
        const subtitleStreams = (data.streams || []).filter(s => s.codec_type === 'subtitle');

        if (!videoStream) {
          return reject(new Error('No video stream found in this file.'));
        }

        const duration = parseFloat(data.format?.duration || videoStream.duration || 0);
        const width = parseInt(videoStream.width || 1920, 10);
        const height = parseInt(videoStream.height || 1080, 10);
        const sizeBytes = parseInt(data.format?.size || fs.statSync(filePath).size, 10);

        resolve({
          duration,
          durationFormatted: formatDuration(duration),
          width,
          height,
          codec: videoStream.codec_name,
          sizeBytes,
          audioTracks: audioStreams.map((a, idx) => ({
            index: idx,
            streamIndex: a.index,
            codec: a.codec_name,
            channels: a.channels,
            language: a.tags?.language || 'und',
            title: a.tags?.title || `Audio Track ${idx + 1}`
          })),
          subtitleTracks: subtitleStreams.map((s, idx) => ({
            index: idx,
            streamIndex: s.index,
            codec: s.codec_name,
            language: s.tags?.language || 'und',
            title: s.tags?.title || `Subtitle Track ${idx + 1}`
          }))
        });
      } catch (parseErr) {
        reject(new Error(`Failed to parse ffprobe output: ${parseErr.message}`));
      }
    });
  });
}

// Escape text for FFmpeg drawtext filter
function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019")
    .replace(/%/g, '\\%')
    .replace(/,/g, '\\,');
}

// Escape font path for FFmpeg on Windows
function getFontFilePath(bold = true) {
  const candidates = bold
    ? [
        'C:/Windows/Fonts/arialbd.ttf',
        'C:/Windows/Fonts/segoeuib.ttf',
        'C:/Windows/Fonts/calibrib.ttf',
        'C:/Windows/Fonts/arial.ttf'
      ]
    : [
        'C:/Windows/Fonts/arial.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/calibri.ttf'
      ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c.replace(/:/g, '\\:');
    }
  }
  return 'C\\:/Windows/Fonts/arial.ttf';
}

// Run single part FFmpeg job
function processPart({
  job,
  movie,
  partNumber,
  totalParts,
  startTime,
  clipDuration,
  options,
  outputFilePath
}) {
  return new Promise((resolve, reject) => {
    const outW = options.resolution === '720p' ? 720 : 1080;
    const aspectMode = options.aspectRatio || '9:16';
    let outH = options.resolution === '720p' ? 1280 : 1920;
    if (aspectMode === '4:5') {
      outH = Math.round((outW * 5) / 4 / 2) * 2;
    } else if (aspectMode === '3:4') {
      outH = Math.round((outW * 4) / 3 / 2) * 2;
    } else if (aspectMode === '1:1') {
      outH = outW;
    }
    const scaleFactor = outW / 1080;

    // Build label text for this part (only "Part 1", "Part 2", etc. without "/ N")
    const cleanTpl = (options.subtitleTemplate || 'Part {n}').split('/')[0].replace(/\{total\}/gi, '').trim() || 'Part {n}';
    const partText = cleanTpl.includes('{n}') ? cleanTpl.replace(/\{n\}/gi, String(partNumber)) : `Part ${partNumber}`;

    const fontFile = getFontFilePath(true);
    const fontSize = Math.round((Number(options.fontSize) || 64) * scaleFactor);
    const fontColor = (options.fontColor || 'white').replace(/[^a-zA-Z0-9#]/g, '');

    // Compute Y position of the centered movie frame with Increased Ratio (frameZoomRatio)
    const zoomRatio = Math.max(1.0, Math.min(2.4, Number(options.frameZoomRatio) || 1.35));
    const movieAspect = (movie.width || 1920) / (movie.height || 1080);
    const targetZoomW = Math.max(outW, Math.round((outW * zoomRatio) / 2) * 2);
    const scaledMovieH = Math.min(outH - 80, Math.max(120, Math.round((targetZoomW / movieAspect) / 2) * 2));
    const actualScaledW = Math.max(outW, Math.round((scaledMovieH * movieAspect) / 2) * 2);
    const movieTopY = Math.round((outH - scaledMovieH) / 2);
    const movieBottomY = movieTopY + scaledMovieH;

    let textYExpr = `${ Math.min(outH - fontSize - 32, movieBottomY + Math.round(55 * scaleFactor)) }`;
    if (options.subtitlePosition === 'top') {
      textYExpr = `${ Math.max(45, movieTopY - fontSize - Math.round(50 * scaleFactor)) }`;
    } else if (options.subtitlePosition === 'bottom_edge') {
      textYExpr = `${ outH - fontSize - Math.round(110 * scaleFactor) }`;
    }

    const vfParts = [
      `scale=${actualScaledW}:${scaledMovieH}:flags=fast_bilinear`,
      `crop=${outW}:${scaledMovieH}`,
      `pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black`,
      `setsar=1`,
      `drawtext=fontfile='${fontFile}':text='${escapeDrawtext(partText)}':fontcolor=${fontColor}:fontsize=${fontSize}:x=(w-text_w)/2:y=${textYExpr}:borderw=${Math.round(3 * scaleFactor)}:bordercolor=black@0.85`
    ];

    // Optional static Movie Title at the top black bar
    if (options.movieTitle && options.movieTitle.trim()) {
      const titleFontSize = Math.round((Number(options.titleFontSize) || 46) * scaleFactor);
      const titleY = Math.max(50, movieTopY - titleFontSize - Math.round(75 * scaleFactor));
      vfParts.push(
        `drawtext=fontfile='${fontFile}':text='${escapeDrawtext(options.movieTitle.trim())}':fontcolor=${options.titleColor || '#fbbf24'}:fontsize=${titleFontSize}:x=(w-text_w)/2:y=${titleY}:borderw=${Math.round(2 * scaleFactor)}:bordercolor=black@0.85`
      );
    }

    const vfString = vfParts.join(',');

    // Write a companion .srt file if embedded subtitle track is also desired
    const srtPath = outputFilePath.replace(/\.mp4$/i, '.srt');
    const endClipStr = formatTimestampFFmpeg(clipDuration).replace('.', ',');
    const srtContent = `1\r\n00:00:00,000 --> ${endClipStr}\r\n${partText}\r\n\r\n`;
    fs.writeFileSync(srtPath, srtContent, 'utf8');

    const audioTrackIdx = Number(options.audioTrackIndex) || 0;
    const selectedAudio = (movie.audioTracks || [])[audioTrackIdx];
    const canCopyAudio = Boolean(
      selectedAudio &&
      selectedAudio.codec === 'aac' &&
      (!selectedAudio.channels || selectedAudio.channels <= 2)
    );

    const buildArgs = (useHardware) => {
      const args = [
        '-y',
        '-ss', String(startTime),
        '-t', String(clipDuration),
        '-i', movie.filePath,
        '-i', srtPath,
        '-map', '0:v:0',
        '-map', movie.audioTracks.length > 0 ? `0:a:${audioTrackIdx}?` : '0:a?',
        '-map', '1:s:0',
        '-vf', vfString
      ];

      if (useHardware) {
        args.push(
          '-c:v', 'h264_qsv',
          '-global_quality', '21',
          '-look_ahead', '0'
        );
      } else {
        args.push(
          '-c:v', 'libx264',
          '-preset', options.cpuPreset || 'ultrafast',
          '-tune', 'fastdecode',
          '-crf', '22',
          '-threads', '0',
          '-pix_fmt', 'yuv420p'
        );
      }

      if (canCopyAudio) {
        args.push('-c:a', 'copy');
      } else {
        args.push(
          '-c:a', 'aac',
          '-ac', '2',
          '-b:a', '160k'
        );
      }

      args.push(
        '-c:s', 'mov_text',
        '-metadata:s:s:0', 'language=eng',
        '-metadata:s:s:0', `title=${partText}`,
        '-movflags', '+faststart',
        outputFilePath
      );
      return args;
    };

    const runFFmpeg = (useHardware) => {
      const args = buildArgs(useHardware);
      const proc = spawn('ffmpeg', args, { windowsHide: true });
      if (!job.activeProcesses) job.activeProcesses = new Set();
      job.activeProcesses.add(proc);
      job.currentProcess = proc;

      let stderrTail = '';
      proc.stderr.on('data', (chunk) => {
        const str = chunk.toString();
        stderrTail = (stderrTail + str).slice(-3000);

        // Parse time=HH:MM:SS.xx from FFmpeg stderr
        const match = str.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
        if (match) {
          const curSec =
            parseInt(match[1], 10) * 3600 +
            parseInt(match[2], 10) * 60 +
            parseFloat(match[3]);
          const pct = Math.min(99, Math.max(0, Math.round((curSec / clipDuration) * 100)));
          if (job.partProgressMap) {
            job.partProgressMap.set(partNumber, pct);
            let sumPct = 0;
            for (const v of job.partProgressMap.values()) sumPct += v;
            job.currentPartProgress = Math.min(99, Math.round(sumPct / Math.max(1, job.partProgressMap.size)));
          } else {
            job.currentPartProgress = pct;
          }
        }
      });

      proc.on('error', (err) => {
        if (job.activeProcesses) job.activeProcesses.delete(proc);
        try { fs.unlinkSync(srtPath); } catch (_) {}
        reject(err);
      });

      proc.on('close', (code) => {
        if (job.activeProcesses) job.activeProcesses.delete(proc);
        job.currentProcess = null;
        if (job.cancelled) {
          try { fs.unlinkSync(srtPath); } catch (_) {}
          return reject(new Error('Job cancelled by user'));
        }
        if (code !== 0) {
          if (useHardware) {
            // Automatic fallback to CPU libx264 if QSV fails
            return runFFmpeg(false);
          }
          try { fs.unlinkSync(srtPath); } catch (_) {}
          return reject(new Error(`FFmpeg exited with code ${code}: ${stderrTail.slice(-400)}`));
        }
        if (job.partProgressMap) job.partProgressMap.delete(partNumber);
        try { fs.unlinkSync(srtPath); } catch (_) {}
        resolve();
      });
    };

    const useHw = Boolean(options.useHardwareWorker || options.encoder === 'qsv');
    runFFmpeg(useHw);
  });
}

async function runSplitJob(job, movie, options) {
  try {
    const rawClipDur = Number(options.clipDurationSeconds) || 295;
    const clipDuration = rawClipDur <= 10 ? 295 : rawClipDur; // Default 4m 55s = 295s
    const totalParts = Math.ceil(movie.duration / clipDuration);
    const startPart = Math.max(1, Math.min(totalParts, parseInt(options.startPart || 1, 10)));
    const endPart = Math.max(startPart, Math.min(totalParts, parseInt(options.endPart || totalParts, 10)));

    job.totalPartsInMovie = totalParts;
    job.startPart = startPart;
    job.endPart = endPart;
    job.totalPartsToRender = endPart - startPart + 1;
    job.partProgressMap = new Map();
    job.activeProcesses = new Set();

    const safeBaseName = path.basename(movie.originalName, path.extname(movie.originalName))
      .replace(/[^a-zA-Z0-9_\-\s]/g, '')
      .trim()
      .replace(/\s+/g, '_') || 'Movie';

    const jobOutputDir = path.join(OUTPUTS_DIR, `${safeBaseName}_${job.id.slice(0, 6)}`);
    if (!fs.existsSync(jobOutputDir)) {
      fs.mkdirSync(jobOutputDir, { recursive: true });
    }
    job.outputDir = jobOutputDir;

    const partQueue = [];
    for (let partNum = startPart; partNum <= endPart; partNum++) {
      const startTime = (partNum - 1) * clipDuration;
      const remaining = movie.duration - startTime;
      const actualDuration = Math.min(clipDuration, remaining);
      if (actualDuration <= 0.5) break;
      partQueue.push({ partNum, startTime, actualDuration });
    }

    job.totalPartsToRender = Math.max(1, partQueue.length);

    // Hybrid Parallel Workers: Worker 0 uses CPU Ultrafast (libx264), Worker 1 uses Intel QSV GPU (with CPU fallback)
    const concurrency = Math.min(2, partQueue.length);
    let queueIdx = 0;
    const finishedByPart = new Map();
    let nextPartToEmit = startPart;

    const flushOrderedParts = () => {
      while (finishedByPart.has(nextPartToEmit)) {
        job.completedParts.push(finishedByPart.get(nextPartToEmit));
        finishedByPart.delete(nextPartToEmit);
        nextPartToEmit++;
      }
    };

    const runWorker = async (workerIndex) => {
      while (queueIdx < partQueue.length) {
        if (job.cancelled) return;
        while (job.paused && !job.cancelled) {
          await new Promise(r => setTimeout(r, 250));
        }
        if (job.cancelled) return;
        const item = partQueue[queueIdx++];
        if (!item) return;

        const { partNum, startTime, actualDuration } = item;
        job.currentPartNumber = partNum;

        const fileName = `${safeBaseName}_Part_${partNum}.mp4`;
        const outputFilePath = path.join(jobOutputDir, fileName);

        // Worker 0 uses primary selected encoder; Worker 1 offloads to GPU hardware (h264_qsv) so CPU + GPU run simultaneously
        const workerOptions = {
          ...options,
          useHardwareWorker: workerIndex === 1 || options.encoder === 'qsv'
        };

        await processPart({
          job,
          movie,
          partNumber: partNum,
          totalParts,
          startTime,
          clipDuration: actualDuration,
          options: workerOptions,
          outputFilePath
        });

        const stat = fs.statSync(outputFilePath);
        finishedByPart.set(partNum, {
          partNumber: partNum,
          totalParts,
          fileName,
          filePath: outputFilePath,
          url: `/outputs/${path.basename(jobOutputDir)}/${encodeURIComponent(fileName)}`,
          startTime,
          endTime: startTime + actualDuration,
          timeRangeFormatted: `${formatDuration(startTime)} - ${formatDuration(startTime + actualDuration)}`,
          durationFormatted: formatDuration(actualDuration),
          sizeBytes: stat.size
        });
        flushOrderedParts();
      }
    };

    const workers = [];
    for (let w = 0; w < concurrency; w++) {
      workers.push(runWorker(w));
    }
    await Promise.all(workers);
    flushOrderedParts();

    if (job.cancelled) {
      job.status = 'cancelled';
      return;
    }

    job.currentPartProgress = 100;
    job.status = 'completed';
    job.completedAt = Date.now();

    // Automatically record completed project into Cloud Projects History
    try {
      const db = loadCloudDb();
      const projectEntry = {
        id: job.id,
        movieName: movie.originalName,
        createdAt: new Date().toISOString(),
        createdBy: options.userEmail || 'vaishnavideapad@gmail.com',
        authProvider: options.authProvider || 'credentials',
        clipDurationSeconds: clipDuration,
        aspectRatio: options.aspectRatio || '9:16',
        frameZoomRatio: Number(options.frameZoomRatio) || 1.35,
        resolution: options.resolution || '1080p',
        totalParts: job.completedParts.length,
        outputDir: job.outputDir,
        parts: job.completedParts.map(p => ({
          partNumber: p.partNumber,
          fileName: p.fileName,
          url: p.url,
          durationFormatted: p.durationFormatted,
          timeRangeFormatted: p.timeRangeFormatted,
          sizeBytes: p.sizeBytes
        }))
      };
      db.projectsHistory.unshift(projectEntry);
      db.projectsHistory = db.projectsHistory.slice(0, 100);

      if (options.playlistName && String(options.playlistName).trim()) {
        const plName = String(options.playlistName).trim();
        let pl = db.playlists.find(x => x.name.toLowerCase() === plName.toLowerCase());
        if (!pl) {
          pl = {
            id: crypto.randomUUID(),
            name: plName,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            createdBy: projectEntry.createdBy,
            projects: []
          };
          db.playlists.unshift(pl);
        }
        pl.updatedAt = new Date().toISOString();
        pl.projects.unshift(projectEntry);
      }

      saveCloudDb(db);
    } catch (dbErr) {
      console.error('Failed to record project in cloud DB:', dbErr.message);
    }
  } catch (err) {
    if (job.cancelled) {
      job.status = 'cancelled';
    } else {
      job.status = 'error';
      job.error = err.message;
    }
  }
}

// Native Windows File Picker using PowerShell so user can pick local MKV/MP4 instantly without waiting for browser upload
function openNativeFilePicker() {
  return new Promise((resolve, reject) => {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$f = New-Object System.Windows.Forms.OpenFileDialog
$f.Title = "Select MKV or MP4 Movie File"
$f.Filter = "Video Files (*.mkv;*.mp4;*.mov;*.avi;*.webm)|*.mkv;*.mp4;*.mov;*.avi;*.webm|All Files (*.*)|*.*"
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
if ($f.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $f.FileName
}
`;
    execFile('powershell', ['-NoProfile', '-STA', '-Command', psScript], (err, stdout) => {
      if (err) return reject(err);
      const selected = stdout.trim();
      resolve(selected || null);
    });
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true'
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Serve static or video file with HTTP Range support for video preview/download
function serveFileWithRange(req, res, filePath, downloadName = null) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    return res.end('Not found');
  }
  const stat = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };
  const contentType = mimeMap[ext] || 'application/octet-stream';
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true'
  };
  if (downloadName) {
    headers['Content-Disposition'] = `attachment; filename="${downloadName.replace(/"/g, '')}"`;
  }

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true'
      });
      return res.end();
    }

    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const pathname = urlObj.pathname;

    if (req.method === 'GET' && pathname === '/api/ping') {
      return sendJson(res, 200, { ok: true, engine: 'local-ffmpeg' });
    }

    // Auth & Cloud Server Endpoints (Projects History & Cloud Playlists for Normal User & Admin Console)
    if (req.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJsonBody(req);
      const email = String(body.username || body.email || '').trim().toLowerCase();
      const pass = String(body.password || '').trim();

      if (
        email === 'vaishnavideapad@gmail.com' &&
        (pass === 'Ideapad@183' || pass === 'ideapad@183' || pass === 'ideapad@1' || pass === 'Ideapad@1')
      ) {
        const isAdminDirect = pass.toLowerCase() === 'ideapad@1';
        return sendJson(res, 200, {
          ok: true,
          user: {
            email: 'vaishnavideapad@gmail.com',
            name: 'Vaishnav Ideapad',
            role: isAdminDirect ? 'admin' : 'user',
            adminUnlocked: isAdminDirect,
            provider: 'password'
          }
        });
      }
      return sendJson(res, 401, { ok: false, error: 'Invalid username or password.' });
    }

    if (req.method === 'POST' && pathname === '/api/auth/admin-login') {
      const body = await readJsonBody(req);
      const email = String(body.username || body.email || '').trim().toLowerCase();
      const pass = String(body.password || '').trim();

      if (
        email === 'vaishnavideapad@gmail.com' &&
        (pass === 'ideapad@1' || pass === 'Ideapad@1' || pass === 'Ideapad@183' || pass === 'ideapad@183')
      ) {
        return sendJson(res, 200, {
          ok: true,
          adminUnlocked: true,
          adminUser: 'vaishnavideapad@gmail.com'
        });
      }
      return sendJson(res, 401, { ok: false, error: 'Invalid Admin Console credentials.' });
    }

    if (req.method === 'GET' && pathname === '/api/cloud/state') {
      const db = loadCloudDb();
      return sendJson(res, 200, {
        ok: true,
        projectsHistory: db.projectsHistory,
        playlists: db.playlists,
        oauthConfig: db.oauthConfig
      });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/record-project') {
      const body = await readJsonBody(req);
      const project = body.project;
      if (!project || !project.movieName) {
        return sendJson(res, 400, { ok: false, error: 'Invalid project payload' });
      }
      const db = loadCloudDb();
      const entry = {
        id: project.id || crypto.randomUUID(),
        movieName: project.movieName,
        createdAt: project.createdAt || new Date().toISOString(),
        createdBy: project.createdBy || 'vaishnavideapad@gmail.com',
        authProvider: project.authProvider || 'credentials',
        clipDurationSeconds: project.clipDurationSeconds || 295,
        aspectRatio: project.aspectRatio || '9:16',
        frameZoomRatio: project.frameZoomRatio || 1.35,
        resolution: project.resolution || '1080p',
        totalParts: project.totalParts || (project.parts ? project.parts.length : 1),
        parts: Array.isArray(project.parts) ? project.parts : []
      };
      db.projectsHistory = [entry, ...db.projectsHistory.filter(p => p.id !== entry.id)].slice(0, 100);
      saveCloudDb(db);
      return sendJson(res, 200, { ok: true, project: entry, projectsHistory: db.projectsHistory, playlists: db.playlists });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/playlist/save') {
      const body = await readJsonBody(req);
      const playlistName = String(body.playlistName || '').trim();
      const project = body.project;
      if (!playlistName) {
        return sendJson(res, 400, { ok: false, error: 'Playlist name is required.' });
      }
      const db = loadCloudDb();
      let pl = db.playlists.find(p => p.name.toLowerCase() === playlistName.toLowerCase());
      if (!pl) {
        pl = {
          id: crypto.randomUUID(),
          name: playlistName,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdBy: body.userEmail || 'vaishnavideapad@gmail.com',
          projects: []
        };
        db.playlists.unshift(pl);
      }
      pl.updatedAt = new Date().toISOString();
      if (project && project.movieName) {
        const projEntry = {
          id: project.id || crypto.randomUUID(),
          movieName: project.movieName,
          createdAt: project.createdAt || new Date().toISOString(),
          createdBy: body.userEmail || project.createdBy || 'vaishnavideapad@gmail.com',
          clipDurationSeconds: project.clipDurationSeconds || 295,
          aspectRatio: project.aspectRatio || '9:16',
          frameZoomRatio: project.frameZoomRatio || 1.35,
          totalParts: project.totalParts || (project.parts ? project.parts.length : 1),
          parts: Array.isArray(project.parts) ? project.parts : []
        };
        pl.projects = [projEntry, ...pl.projects.filter(x => x.id !== projEntry.id)];
        // Also ensure it is in projectsHistory
        if (!db.projectsHistory.some(h => h.id === projEntry.id)) {
          db.projectsHistory.unshift(projEntry);
        }
      }
      saveCloudDb(db);
      return sendJson(res, 200, { ok: true, playlist: pl, playlists: db.playlists, projectsHistory: db.projectsHistory });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/playlist/delete') {
      const body = await readJsonBody(req);
      const db = loadCloudDb();
      if (body.playlistId) {
        db.playlists = db.playlists.filter(p => p.id !== body.playlistId);
      }
      if (body.projectId) {
        db.projectsHistory = db.projectsHistory.filter(p => p.id !== body.projectId);
      }
      saveCloudDb(db);
      return sendJson(res, 200, { ok: true, playlists: db.playlists, projectsHistory: db.projectsHistory });
    }

    if (req.method === 'POST' && pathname === '/api/cloud/oauth-config') {
      const body = await readJsonBody(req);
      const db = loadCloudDb();
      db.oauthConfig = {
        facebookAppId: String(body.facebookAppId || '').trim(),
        instagramAppId: String(body.instagramAppId || '').trim()
      };
      saveCloudDb(db);
      return sendJson(res, 200, { ok: true, oauthConfig: db.oauthConfig });
    }

    // 1. Upload movie via streaming binary POST (/api/upload?filename=...)
    if (req.method === 'POST' && pathname === '/api/upload') {
      const rawName = urlObj.searchParams.get('filename') || 'movie.mp4';
      const ext = path.extname(rawName).toLowerCase() || '.mp4';
      const id = crypto.randomUUID();
      const safeFile = `${id}${ext}`;
      const savePath = path.join(UPLOADS_DIR, safeFile);

      const writeStream = fs.createWriteStream(savePath);
      req.pipe(writeStream);

      writeStream.on('finish', async () => {
        try {
          const meta = await probeMovie(savePath);
          const movieRecord = {
            id,
            originalName: rawName,
            filePath: savePath,
            isUploadedCopy: true,
            ...meta
          };
          movies.set(id, movieRecord);
          sendJson(res, 200, { ok: true, movie: movieRecord });
        } catch (probeErr) {
          try { fs.unlinkSync(savePath); } catch (_) {}
          sendJson(res, 400, { ok: false, error: probeErr.message });
        }
      });

      writeStream.on('error', (err) => {
        sendJson(res, 500, { ok: false, error: err.message });
      });
      return;
    }

    // 2. Open native Windows file picker (/api/pick-local-file)
    if (req.method === 'POST' && pathname === '/api/pick-local-file') {
      const selectedPath = await openNativeFilePicker();
      if (!selectedPath) {
        return sendJson(res, 200, { ok: true, cancelled: true });
      }
      if (!fs.existsSync(selectedPath)) {
        return sendJson(res, 400, { ok: false, error: 'Selected file does not exist.' });
      }
      const meta = await probeMovie(selectedPath);
      const id = crypto.randomUUID();
      const movieRecord = {
        id,
        originalName: path.basename(selectedPath),
        filePath: selectedPath,
        isUploadedCopy: false,
        ...meta
      };
      movies.set(id, movieRecord);
      return sendJson(res, 200, { ok: true, movie: movieRecord });
    }

    // 3. Load movie by direct local path (/api/load-path)
    if (req.method === 'POST' && pathname === '/api/load-path') {
      const body = await readJsonBody(req);
      const cleanPath = String(body.filePath || '').replace(/^["']|["']$/g, '').trim();
      if (!cleanPath || !fs.existsSync(cleanPath)) {
        return sendJson(res, 400, { ok: false, error: 'File not found at the specified path.' });
      }
      const meta = await probeMovie(cleanPath);
      const id = crypto.randomUUID();
      const movieRecord = {
        id,
        originalName: path.basename(cleanPath),
        filePath: cleanPath,
        isUploadedCopy: false,
        ...meta
      };
      movies.set(id, movieRecord);
      return sendJson(res, 200, { ok: true, movie: movieRecord });
    }

    // 4. Generate a quick demo test movie so user can test splitting immediately
    if (req.method === 'POST' && pathname === '/api/create-demo-movie') {
      const demoPath = path.join(UPLOADS_DIR, 'Demo_Movie_Sample.mkv');
      if (!fs.existsSync(demoPath) || fs.statSync(demoPath).size < 500000) {
        await new Promise((resolve, reject) => {
          const fontFile = getFontFilePath(true);
          const args = [
            '-y',
            '-f', 'lavfi',
            '-i', 'testsrc=size=1280x720:rate=24:duration=650',
            '-f', 'lavfi',
            '-i', 'sine=frequency=440:sample_rate=44100:duration=650',
            '-vf', `drawtext=fontfile='${fontFile}':text='DEMO MOVIE SCENE':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=60:box=1:boxcolor=black@0.6:boxborderw=12`,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '26',
            '-g', '120',
            '-c:a', 'aac',
            '-b:a', '96k',
            demoPath
          ];
          execFile('ffmpeg', args, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr || err.message));
            resolve();
          });
        });
      }
      const meta = await probeMovie(demoPath);
      const id = crypto.randomUUID();
      const movieRecord = {
        id,
        originalName: 'Demo_Movie_Sample.mkv',
        filePath: demoPath,
        isUploadedCopy: false,
        ...meta
      };
      movies.set(id, movieRecord);
      return sendJson(res, 200, { ok: true, movie: movieRecord });
    }

    // 5. Start splitting job (/api/start-job)
    if (req.method === 'POST' && pathname === '/api/start-job') {
      const body = await readJsonBody(req);
      const movie = movies.get(body.movieId);
      if (!movie) {
        return sendJson(res, 404, { ok: false, error: 'Movie session not found. Please select or upload the movie again.' });
      }

      const jobId = crypto.randomUUID();
      const job = {
        id: jobId,
        movieId: movie.id,
        movieName: movie.originalName,
        status: 'running',
        startedAt: Date.now(),
        completedAt: null,
        currentPartNumber: 1,
        currentPartProgress: 0,
        totalPartsInMovie: 1,
        totalPartsToRender: 1,
        startPart: 1,
        endPart: 1,
        outputDir: '',
        completedParts: [],
        error: null,
        cancelled: false,
        currentProcess: null
      };

      jobs.set(jobId, job);
      runSplitJob(job, movie, body.options || {});

      return sendJson(res, 200, { ok: true, jobId });
    }

    // 6. Get job status (/api/job-status?jobId=...)
    if (req.method === 'GET' && pathname === '/api/job-status') {
      const jobId = urlObj.searchParams.get('jobId');
      const job = jobs.get(jobId);
      if (!job) {
        return sendJson(res, 404, { ok: false, error: 'Job not found' });
      }
      return sendJson(res, 200, {
        ok: true,
        job: {
          id: job.id,
          movieName: job.movieName,
          status: job.status,
          startedAt: job.startedAt,
          completedAt: job.completedAt,
          currentPartNumber: job.currentPartNumber,
          currentPartProgress: job.currentPartProgress,
          totalPartsInMovie: job.totalPartsInMovie,
          totalPartsToRender: job.totalPartsToRender,
          startPart: job.startPart,
          endPart: job.endPart,
          outputDir: job.outputDir,
          completedParts: job.completedParts,
          error: job.error
        }
      });
    }

    // 7. Cancel running job (/api/cancel-job)
    if (req.method === 'POST' && pathname === '/api/cancel-job') {
      const body = await readJsonBody(req);
      const job = jobs.get(body.jobId);
      if (job) {
        job.cancelled = true;
        if (job.activeProcesses) {
          for (const proc of job.activeProcesses) {
            try { proc.kill('SIGKILL'); } catch (_) {}
          }
        }
        if (job.currentProcess) {
          try { job.currentProcess.kill('SIGKILL'); } catch (_) {}
        }
      }
      return sendJson(res, 200, { ok: true });
    }

    // 7b. Pause running job (/api/pause-job)
    if (req.method === 'POST' && pathname === '/api/pause-job') {
      const body = await readJsonBody(req);
      const job = jobs.get(body.jobId);
      if (job) {
        job.paused = true;
        job.status = 'paused';
      }
      return sendJson(res, 200, { ok: true, paused: true });
    }

    // 7c. Resume paused job (/api/resume-job)
    if (req.method === 'POST' && pathname === '/api/resume-job') {
      const body = await readJsonBody(req);
      const job = jobs.get(body.jobId);
      if (job) {
        job.paused = false;
        job.status = 'running';
      }
      return sendJson(res, 200, { ok: true, paused: false });
    }

    // 8. Open Output Folder in Windows Explorer (/api/open-folder)
    if (req.method === 'POST' && pathname === '/api/open-folder') {
      const body = await readJsonBody(req);
      const targetDir = body.folderPath && fs.existsSync(body.folderPath) ? body.folderPath : OUTPUTS_DIR;
      execFile('explorer.exe', [targetDir]);
      return sendJson(res, 200, { ok: true, opened: targetDir });
    }

    // 9. Serve output clips (/outputs/<folder>/<file>)
    if (req.method === 'GET' && pathname.startsWith('/outputs/')) {
      const rel = pathname.slice('/outputs/'.length);
      const parts = rel.split('/').map(p => decodeURIComponent(p));
      const safePath = path.normalize(path.join(OUTPUTS_DIR, ...parts));
      if (!safePath.startsWith(OUTPUTS_DIR)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      const isDownload = urlObj.searchParams.get('download') === '1';
      return serveFileWithRange(req, res, safePath, isDownload ? path.basename(safePath) : null);
    }

    // 10. Serve static frontend files
    let staticPath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
    staticPath = path.normalize(staticPath);
    if (staticPath.startsWith(PUBLIC_DIR) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
      return serveFileWithRange(req, res, staticPath);
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  V Splitter is running!`);
  console.log(`  Open in browser: http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
