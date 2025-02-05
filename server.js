// Backend kodları (server.js veya index.js dosyanız)
const express = require("express");
const https = require("https");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const http = require("http");

const app = express();

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

const server = https.createServer(credentials, app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  },
});

app.get("/health", (req, res) => {
  res.status(200).send("Sunucu çalışıyor!");
});

app.use(cors());
app.use(express.json());

// HTTP'den HTTPS'ye Yönlendirme
app.use((req, res, next) => {
  if (!req.secure) {
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
        "Geçersiz dosya formatı. Sadece MP4, AVI ve MKV formatları desteklenir."
      ),
      false
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
let lastTime = Date.now();
let lastBytes = 0;
const calculateSpeed = (currentChunkLength) => {
  const currentTime = Date.now();
  const timeDiff = (currentTime - lastTime) / 1000;
  if (timeDiff > 0) {
    const speed = (currentChunkLength - lastBytes) / timeDiff;
    lastTime = currentTime;
    lastBytes = currentChunkLength;
    return Math.round(speed / 1024);
  }
  return 0;
};

app.post("/upload", checkTotalFileSize, (req, res) => {
  if (isUploading) {
    return res
      .status(400)
      .send({ message: "Şu anda başka bir yükleme işlemi devam ediyor." });
  }
  isUploading = true;
  io.emit("upload-start");
  let uploadedBytes = 0;
  try {
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

    req.on("data", (chunk) => {
      uploadedBytes += chunk.length;
      const totalBytes = parseInt(req.headers["content-length"], 10);
      const progress = totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0;
      io.emit("upload-progress", {
        progress: Math.round(progress),
        speed: calculateSpeed(chunk.length),
      });
    });
  } catch (error) {
    isUploading = false;
    io.emit("upload-end");
    console.error("Video yükleme sırasında bir hata oluştu:", error);
    res.status(500).send({ message: "Sunucu hatası: Video yüklenemedi." });
  }
});

app.delete("/videos/:filename", async (req, res) => {
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
      const caller = users[socket.id];
      const callee = users[to];

      if (!caller.hasAudio && !caller.hasVideo) {
        socket.emit("call-error", "En az bir medya cihazı etkin olmalıdır");
        return;
      }

      if (!activeCalls[to] && !activeCalls[socket.id]) {
        activeCalls[to] = socket.id;
        activeCalls[socket.id] = to;
        io.to(to).emit("incoming-call", { from: socket.id });
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
    connectedUsers = Object.keys(users).length;
    io.emit("user-count-update", connectedUsers);
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

  handleWebRTCEvents(socket);
});

app.use((err, req, res, next) => {
  console.error("Express Error Handler:", err);
  res
    .status(500)
    .json({ error: "Sunucuda bir hata oluştu. Detaylar konsolda yer alıyor." });
});

const PORT = 8443;
server.listen(PORT, () => {
  console.log(`Sunucu HTTPS üzerinden ${PORT} portunda çalışıyor.`);
});
