// Backend kodları (server.js veya index.js dosyanız)
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
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 100, // Her IP için maksimum istek sayısı
});

app.use(limiter);

// HTTPS Sertifikaları (Kendi yolunuzu kullanın)
const credentials = {
  key: fs.readFileSync(
    "/etc/letsencrypt/live/watchtogether.duckdns.org/privkey.pem",
    "utf8",
  ),
  cert: fs.readFileSync(
    "/etc/letsencrypt/live/watchtogether.duckdns.org/fullchain.pem",
    "utf8",
  ),
};

const server = https.createServer(credentials, app);
const io = new Server(server, {
  cors: {
    origin:
      process.env.NODE_ENV === "production"
        ? ["https://watchtogether.duckdns.org"]
        : "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    credentials: true,
  },
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

const uploadDir = path.join(__dirname, "videos");
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
        "Geçersiz dosya formatı. Sadece MP4, AVI ve MKV formatları desteklenir.",
      ),
      false,
    );
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 16 * 1024 * 1024 * 1024 },
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
  windowMs: 60 * 60 * 1000, // 1 saat
  max: 5, // Her IP için maksimum yükleme sayısı
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

        activeCalls[to] = socket.id;
        activeCalls[socket.id] = to;
        io.to(to).emit("incoming-call", { from: socket.id });
      } catch (error) {
        console.error("Arama başlatma hatası:", error);
        socket.emit("call-error", "Arama başlatılamadı");
      }
    },
    "accept-call": ({ signal, to }) => {
      io.to(to).emit("call-accepted", { signal, answerId: socket.id });
    },
    "ice-candidate": (data) => {
      if (data.to && activeCalls[socket.id] === data.to) {
        io.to(data.to).emit("ice-candidate", data.candidate);
      }
    },
    "call-user": ({ signal, to }) => {
      if (activeCalls[to] === socket.id) {
        io.to(to).emit("incoming-call", {
          signal,
          from: socket.id,
          username: users[socket.id]?.username,
        });
      }
    },
    "end-call": ({ to }) => {
      if (activeCalls[socket.id]) {
        const targetSocketId = activeCalls[socket.id];
        delete activeCalls[socket.id];
        delete activeCalls[targetSocketId];
        io.to(targetSocketId).emit("call-ended");
      }
    },
  };

  for (const eventName in events) {
    socket.on(eventName, events[eventName]);
  }
};

let connectedUsers = 0;
io.on("connection", (socket) => {
  connectedUsers++;
  console.log(
    `Yeni soket bağlandı: ${socket.id}, Toplam Bağlantı: ${connectedUsers}`,
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
      `Soket ayrıldı: ${socket.id}, Toplam Bağlantı: ${connectedUsers}`,
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

  let heartbeat = setInterval(() => {
    socket.emit("ping");
  }, 25000);

  socket.on("pong", () => {
    console.log(`Heartbeat from ${socket.id}`);
  });

  handleWebRTCEvents(socket);
});

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

const PORT = 8443;
server.listen(PORT, () => {
  console.log(`Sunucu HTTPS üzerinden ${PORT} portunda çalışıyor.`);
});
