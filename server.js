require("dotenv").config();
const express = require("express");
const https = require("https");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const app = express();

// Güvenlik önlemleri
app.use(helmet());

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS),
});

app.use(limiter);

// HTTPS Sertifikaları (Kendi yolunuzu kullanın)
const credentials = {
  key: fs.readFileSync(
    "/etc/letsencrypt/live/watchtogether.duckdns.org/privkey.pem",
    "utf8"
  ),
  cert: fs.readFileSync(
    "/etc/letsencrypt/live/watchtogether.duckdns.org/fullchain.pem",
    "utf8"
  ),
};

// CORS yapılandırması
const corsOptions = {
  origin:"*",
  methods: process.env.CORS_METHODS.split(","),
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "x-auth-token"],
};

app.use(cors(corsOptions));

// HTTPS ve HTTP sunucuları
let server;
if (process.env.NODE_ENV === "production") {
  try {
    const credentials = {
      key: fs.readFileSync(process.env.SSL_KEY_PATH, "utf8"),
      cert: fs.readFileSync(process.env.SSL_CERT_PATH, "utf8"),
      ca: fs.readFileSync(process.env.SSL_CA_PATH, "utf8"),
    };
    server = https.createServer(credentials, app);
  } catch (error) {
    console.error("HTTPS sertifika hatası:", error);
    console.log("HTTP sunucusu başlatılıyor...");
    server = http.createServer(app);
  }
} else {
  server = http.createServer(app);
}

// Socket.IO yapılandırması
const io = new Server(server, {
  cors: corsOptions,
  pingTimeout: parseInt(process.env.WS_PING_TIMEOUT),
  pingInterval: parseInt(process.env.WS_PING_INTERVAL),
  transports: ["websocket", "polling"],
  allowEIO3: true,
  maxHttpBufferSize: 1e8,
  path: "/socket.io",
});

// WebSocket hata yönetimi
io.engine.on("connection_error", (err) => {
  console.error("Socket.IO bağlantı hatası:", err);
});

app.get("/health", (req, res) => {
  res.status(200).send("Sunucu çalışıyor!");
});

app.use(express.json());

// HTTP'den HTTPS'ye Yönlendirme (x-forwarded-proto kontrolü eklendi)
app.use((req, res, next) => {
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!req.secure && (!forwardedProto || forwardedProto !== "https")) {
    return res.redirect(`https://${req.headers.host}${req.url}`);
  }
  next();
});

app.use("/videos", express.static(path.join(__dirname, "videos")));

const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedMimeTypes = ["video/mp4", "video/avi", "video/x-matroska"];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Geçersiz dosya formatı. Sadece MP4, AVI ve MKV formatları desteklenir."
      ),
      false
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: process.env.MAX_FILE_SIZE },
});

const checkTotalFileSize = async (req, res, next) => {
  const maxSize = 16 * 1024 * 1024 * 1024;
  let currentTotalSize = 0;
  try {
    const files = await fs.promises.readdir(uploadDir);
    for (const file of files) {
      const stats = await fs.promises.stat(path.join(uploadDir, file));
      currentTotalSize += stats.size;
    }
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);
    if (currentTotalSize + contentLength > maxSize) {
      return res.status(413).send({
        message:
          "Toplam dosya boyutu sınırı aşıldı (maksimum 16GB). Yeni dosya yüklenemez.",
      });
    }
    req.setTimeout(6 * 60 * 60 * 1000);
    next();
  } catch (error) {
    console.error("Toplam dosya boyutu kontrolü sırasında hata:", error);
    return res
      .status(500)
      .send({ message: "Sunucu hatası: Toplam boyut kontrolü yapılamadı." });
  }
};

let isUploading = false;

// Video upload geliştirmeleri
const videoUploadLimiter = rateLimit({
  windowMs: parseInt(process.env.UPLOAD_RATE_LIMIT_WINDOW_MS),
  max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX),
});

app.post("/upload", videoUploadLimiter, checkTotalFileSize, (req, res) => {
  if (isUploading) {
    return res
      .status(400)
      .send({ message: "Şu anda başka bir yükleme işlemi devam ediyor." });
  }
  isUploading = true;
  io.emit("upload-start");
  let uploadedBytes = 0;
  let lastUpdateTime = Date.now();
  let lastUpdateBytes = 0;

  req.on("data", (chunk) => {
    uploadedBytes += chunk.length;
    const now = Date.now();
    const timeDiff = (now - lastUpdateTime) / 1000;
    let speed = 0;
    if (timeDiff > 0) {
      speed = Math.round((uploadedBytes - lastUpdateBytes) / timeDiff / 1024);
    }
    lastUpdateTime = now;
    lastUpdateBytes = uploadedBytes;
    const totalBytes = parseInt(req.headers["content-length"] || "0", 10);
    const progress = totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0;
    io.emit("upload-progress", {
      progress: Math.round(progress),
      speed: speed,
    });
  });

  upload.single("video")(req, res, (err) => {
    isUploading = false;
    io.emit("upload-end");
    if (err) {
      console.error("Yükleme hatası:", err.message);
      return res
        .status(400)
        .send({ message: `Yükleme hatası: ${err.message}` });
    }
    if (!req.file) {
      return res
        .status(400)
        .send({ message: "Lütfen geçerli bir video dosyası yükleyin." });
    }
    console.log("Dosya başarıyla yüklendi:", req.file.filename);
    res.status(200).send({
      message: "Dosya başarıyla yüklendi!",
      filename: req.file.filename,
    });
  });
});

// Dosya silme işlemi için güvenlik kontrolü
const deleteAuth = (req, res, next) => {
  const authToken = req.headers["x-auth-token"];
  if (!authToken || authToken !== process.env.DELETE_AUTH_TOKEN) {
    return res.status(401).json({ message: "Yetkisiz işlem" });
  }
  next();
};

app.delete("/videos/:filename", deleteAuth, async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);
  try {
    await fs.promises.unlink(filePath);
    console.log(`Dosya başarıyla silindi: ${filename}`);
    io.emit("video-deleted", filename);
    res.status(200).send({ message: "Dosya başarıyla silindi!" });
  } catch (error) {
    console.error("Dosya silinirken bir hata oluştu:", error);
    if (error.code === "ENOENT") {
      return res.status(404).send({ message: "Dosya bulunamadı." });
    }
    res.status(500).send({ message: "Sunucu hatası: Dosya silinemedi." });
  }
});

const users = {}; // { socketId: { username, id, hasAudio, hasVideo } }
const SERVER_ROOM = "server-room"; // Sabit oda adı
const MAX_USERS = 2;
let videoState = {
  isPlaying: false,
  currentTime: 0,
  muted: false,
  volume: 1,
  currentVideo: null,
  lastUpdatedBy: null,
};

const iceServers = [
  {
    urls: [
      "stun:stun.l.google.com:19302",
      "turn:35.179.115.239:3478?transport=udp",
      "turn:35.179.115.239:3478?transport=tcp",
    ],
    username: "bahadr",
    credential: "bahadr12345",
  },
];

const activeCalls = {};

const handleWebRTCEvents = (socket) => {
  const events = {
    "initiate-call": ({ to }) => {
      try {
        const caller = users[socket.id];
        const callee = users[to];

        if (!caller || !callee) {
          socket.emit("call-error", "Kullanıcı bulunamadı");
          return;
        }

        if (!caller.hasAudio && !caller.hasVideo) {
          socket.emit("call-error", "En az bir medya cihazı etkin olmalıdır");
          return;
        }

        if (activeCalls[to] || activeCalls[socket.id]) {
          socket.emit("call-error", "Kullanıcı zaten bir görüşmede");
          return;
        }

        activeCalls[to] = {
          id: socket.id,
          timestamp: Date.now(),
          type: "pending",
        };

        activeCalls[socket.id] = {
          id: to,
          timestamp: Date.now(),
          type: "pending",
        };

        io.to(to).emit("incoming-call", {
          from: socket.id,
          username: caller.username,
        });

        // 30 saniye içinde cevap verilmezse aramayı sonlandır
        setTimeout(() => {
          if (activeCalls[socket.id]?.type === "pending") {
            delete activeCalls[socket.id];
            delete activeCalls[to];
            socket.emit("call-timeout");
            io.to(to).emit("call-missed");
          }
        }, 30000);
      } catch (error) {
        console.error("Arama başlatma hatası:", error);
        socket.emit("call-error", "Arama başlatılamadı");
      }
    },

    "accept-call": ({ signal, to }) => {
      if (activeCalls[socket.id]?.id === to) {
        activeCalls[socket.id].type = "active";
        activeCalls[to].type = "active";
        io.to(to).emit("call-accepted", {
          signal,
          answerId: socket.id,
        });
      }
    },

    "reject-call": ({ to }) => {
      if (activeCalls[socket.id]?.id === to) {
        delete activeCalls[socket.id];
        delete activeCalls[to];
        io.to(to).emit("call-rejected");
      }
    },

    "ice-candidate": (data) => {
      if (data.to && activeCalls[socket.id]?.id === data.to) {
        io.to(data.to).emit("ice-candidate", data.candidate);
      }
    },

    "end-call": ({ to }) => {
      if (activeCalls[socket.id]) {
        const targetSocketId = activeCalls[socket.id].id;
        delete activeCalls[socket.id];
        delete activeCalls[targetSocketId];
        io.to(targetSocketId).emit("call-ended");
      }
    },
  };

  for (const [event, handler] of Object.entries(events)) {
    socket.on(event, (...args) => {
      try {
        handler(...args);
      } catch (error) {
        console.error(`WebRTC event error (${event}):`, error);
        socket.emit("call-error", "İşlem sırasında bir hata oluştu");
      }
    });
  }
};

// Video senkronizasyon iyileştirmeleri
const videoStateManager = {
  state: {
    isPlaying: false,
    currentTime: 0,
    muted: false,
    volume: 1,
    currentVideo: null,
    lastUpdatedBy: null,
    lastUpdateTime: Date.now(),
  },

  updateState(newState, socket) {
    const now = Date.now();
    if (now - this.state.lastUpdateTime > 500) {
      this.state = {
        ...this.state,
        ...newState,
        lastUpdatedBy: socket.id,
        lastUpdateTime: now,
      };
      socket.broadcast.to(SERVER_ROOM).emit("video-state", this.state);
    }
  },

  handleStateChange(socket) {
    socket.on("play", (currentTime) => {
      this.updateState({ isPlaying: true, currentTime }, socket);
    });

    socket.on("pause", (currentTime) => {
      this.updateState({ isPlaying: false, currentTime }, socket);
    });

    socket.on("seek", (time) => {
      this.updateState({ currentTime: time }, socket);
    });

    socket.on("volume-change", (volume) => {
      this.updateState({ volume }, socket);
    });

    socket.on("mute", () => {
      this.updateState({ muted: true }, socket);
    });

    socket.on("unmute", () => {
      this.updateState({ muted: false }, socket);
    });
  },
};

let connectedUsers = 0;
io.on("connection", (socket) => {
  connectedUsers++;
  console.log(
    `Yeni soket bağlandı: ${socket.id}, Toplam Bağlantı: ${connectedUsers}`
  );

  socket.join(SERVER_ROOM);

  socket.on("user-join", (username) => {
    if (connectedUsers > MAX_USERS) {
      socket.emit("server-full");
      socket.disconnect(true);
      return;
    }

    users[socket.id] = {
      username,
      id: socket.id,
      hasAudio: true,
      hasVideo: true,
    };

    io.to(SERVER_ROOM).emit("user-updated", Object.values(users));
    io.to(SERVER_ROOM).emit("user-joined", {
      username,
      id: socket.id,
      totalUsers: Object.values(users).length,
    });
  });

  socket.on("get-videos", () => {
    fs.readdir(uploadDir, (err, files) => {
      if (err) {
        console.error("Video dizini okunurken hata:", err);
        return;
      }
      socket.emit("available-videos", files);
    });
  });

  socket.emit("upload-status", isUploading);

  Object.keys(users).forEach((userId) => {
    if (userId !== socket.id) {
      socket.emit("remote-media-toggled", {
        socketId: users[userId].id,
        audio: users[userId].hasAudio,
        video: users[userId].hasVideo,
      });
    }
  });

  socket.emit("ice-servers", iceServers);

  socket.on("toggle-media", ({ audio, video }) => {
    users[socket.id].hasAudio = audio;
    users[socket.id].hasVideo = video;

    io.to(SERVER_ROOM).emit("remote-media-updated", {
      userId: socket.id,
      audio,
      video,
    });
  });

  socket.on("play", (currentTime) => {
    videoState = {
      ...videoState,
      isPlaying: true,
      currentTime,
      lastUpdatedBy: socket.id,
    };
    io.to(SERVER_ROOM).emit("video-state", videoState);
  });

  socket.on("pause", (currentTime) => {
    videoState = {
      ...videoState,
      isPlaying: false,
      currentTime,
      lastUpdatedBy: socket.id,
    };
    io.to(SERVER_ROOM).emit("video-state", videoState);
  });

  socket.on("seek", (time) => {
    videoState = {
      ...videoState,
      currentTime: time,
      lastUpdatedBy: socket.id,
    };
    io.to(SERVER_ROOM).emit("video-state", videoState);
  });

  socket.on("mute", () => {
    videoState.muted = true;
    io.to(SERVER_ROOM).emit("mute");
  });

  socket.on("unmute", () => {
    videoState.muted = false;
    io.to(SERVER_ROOM).emit("unmute");
  });

  socket.on("volume-change", (volume) => {
    videoState.volume = volume;
    io.to(SERVER_ROOM).emit("volume-change", volume);
  });

  socket.on("select-video", (filename) => {
    videoState.currentVideo = filename;
    videoState.isPlaying = false;
    videoState.currentTime = 0;
    io.to(SERVER_ROOM).emit("video-selected", filename);
    io.to(SERVER_ROOM).emit("video-state", videoState);
  });

  socket.on("audio-toggle", (audio) => {
    if (users[socket.id]) {
      users[socket.id].hasAudio = audio;
      io.to(SERVER_ROOM).emit("remote-media-updated", {
        userId: socket.id,
        audio,
        video: users[socket.id].hasVideo,
      });
    }
  });

  socket.on("video-toggle", (video) => {
    if (users[socket.id]) {
      users[socket.id].hasVideo = video;
      io.to(SERVER_ROOM).emit("remote-media-updated", {
        userId: socket.id,
        audio: users[socket.id].hasAudio,
        video,
      });
    }
  });

  socket.on("disconnect", () => {
    connectedUsers--;
    console.log(
      `Soket ayrıldı: ${socket.id}, Toplam Bağlantı: ${connectedUsers}`
    );
    if (users[socket.id]) {
      console.log("Kullanıcı ayrıldı:", users[socket.id].username, socket.id);
      delete users[socket.id];
      io.to(SERVER_ROOM).emit("existing-users", Object.values(users));
      io.to(SERVER_ROOM).emit("user-left", socket.id);
      socket.leave(SERVER_ROOM);
    }
  });

  let lastUpdateTime = 0;
  socket.on("time-update", (time) => {
    const now = Date.now();
    if (now - lastUpdateTime > 2000) {
      lastUpdateTime = now;
      socket.broadcast.emit("time-update", time);
    }
  });

  let lastPing = Date.now();

  const checkConnection = setInterval(() => {
    if (Date.now() - lastPing > 30000) {
      console.log(`Bağlantı zaman aşımı: ${socket.id}`);
      socket.disconnect(true);
    }
  }, 10000);

  socket.on("pong", () => {
    lastPing = Date.now();
  });

  let lastVideoUpdate = 0;
  socket.on("video-state-update", (state) => {
    const now = Date.now();
    if (now - lastVideoUpdate > 500) {
      // Rate limiting
      lastVideoUpdate = now;
      videoState = { ...state, lastUpdatedBy: socket.id };
      socket.broadcast.to(SERVER_ROOM).emit("video-state", videoState);
    }
  });

  socket.on("error", (error) => {
    console.error(`Socket hatası (${socket.id}):`, error);
    socket.emit("error-occurred", {
      message: "Bir hata oluştu, lütfen sayfayı yenileyin.",
    });
  });

  videoStateManager.handleStateChange(socket);

  handleWebRTCEvents(socket);
});

// Dosya temizleme fonksiyonu
const cleanupOldFiles = async () => {
  try {
    const files = await fs.promises.readdir(uploadDir);
    const now = Date.now();
    const retentionPeriod = parseInt(process.env.FILE_RETENTION_PERIOD);

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.promises.stat(filePath);
      if (now - stats.mtime.getTime() > retentionPeriod) {
        await fs.promises.unlink(filePath);
        console.log(`Eski dosya silindi: ${file}`);
      }
    }
  } catch (error) {
    console.error("Dosya temizleme hatası:", error);
  }
};

// Her gün dosya temizliği yap
setInterval(cleanupOldFiles, parseInt(process.env.AUTO_CLEANUP_INTERVAL));

app.use((err, req, res, next) => {
  console.error("Hata:", err.stack);
  res.status(500).json({
    error: true,
    message:
      process.env.NODE_ENV === "production"
        ? "Sunucu hatası oluştu"
        : err.message,
  });
});

// Global hata yönetimi
process.on("uncaughtException", (error) => {
  console.error("Yakalanmamış hata:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("İşlenmeyen promise reddi:", reason);
});

// Güvenlik önlemleri
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// API rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: "Çok fazla istek gönderildi, lütfen daha sonra tekrar deneyin.",
  },
});

app.use("/api/", apiLimiter);

// Port yapılandırması
const PORT = process.env.PORT || 8443;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  const protocol = server instanceof https.Server ? "HTTPS" : "HTTP";
  console.log(
    `Sunucu ${protocol} üzerinden ${HOST}:${PORT} adresinde çalışıyor.`
  );
});
