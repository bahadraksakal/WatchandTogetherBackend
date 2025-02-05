// Backend kodları (server.js veya index.js dosyanız)
const express = require("express");
const https = require("https");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

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

let connectedUsers = 0;
const users = {}; // { socketId: { username, id, hasAudio, hasVideo } }
const SERVER_ROOM = "server-room"; // Sabit oda adı
let videoState = {
  isPlaying: false,
  currentTime: 0,
  muted: false,
  volume: 1,
  currentVideo: null,
};

const iceServers = [
  {
    urls: [
      "turn:35.179.115.239:3478?transport=udp",
      "turn:35.179.115.239:3478?transport=tcp",
      "turns:watchtogetherturn.duckdns.org:5349?transport=udp",
      "turns:watchtogetherturn.duckdns.org:5349?transport=tcp",
    ],
    username: "bahadr",
    credential: "bahadr12345",
    realm: "watchtogetherturn", // **REALM'i buraya ekleyin ve `watchtogetherturn` olarak ayarlayın.**
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
    "end-call": ({ to }) => {
      if (activeCalls[to]) {
        io.to(activeCalls[to]).emit("call-ended");
        io.to(to).emit("call-ended");
        delete activeCalls[to];
      }
    },
    "ice-candidate": (data) => {
      if (data.to && activeCalls[socket.id] === data.to) {
        io.to(data.to).emit("ice-candidate", data.candidate);
      }
    },
    "call-user": async ({ signal, to }) => {
      const targetSocket = io.sockets.sockets.get(to);
      if (targetSocket) {
        targetSocket.emit("incoming-call", {
          from: socket.id,
          signal,
        });
      }
    },
    "accept-call": async ({ signal, to }) => {
      const targetSocket = io.sockets.sockets.get(to);
      if (targetSocket) {
        targetSocket.emit("call-accepted", signal);
      }
    },
  };

  Object.entries(events).forEach(([eventName, handler]) => {
    socket.on(eventName, (...args) => {
      try {
        handler(...args);
      } catch (error) {
        console.error(`${eventName} hatası:`, error);
        socket.emit("webrtc-error", {
          event: eventName,
          message: error.message,
        });
      }
    });
  });
};

io.on("connection", (socket) => {
  console.log(`Yeni bir soket bağlandı: ${socket.id}`);

  socket.onAny((eventName, ...args) => {
    const dataSnippet =
      args.length > 0
        ? JSON.stringify(args.length === 1 ? args[0] : args).substring(0, 100) +
          "..."
        : "";
    console.log(
      `Gelen Olay: ${eventName} - Veri: ${dataSnippet} (Soket ID: ${socket.id})`
    );
  });

  const originalEmit = socket.emit;
  socket.emit = function (eventName, ...args) {
    const dataSnippet =
      args.length > 0
        ? JSON.stringify(args.length === 1 ? args[0] : args).substring(0, 100) +
          "..."
        : "";
    console.log(
      `Giden Olay: ${eventName} - Veri: ${dataSnippet} (Soket ID: ${socket.id})`
    );
    originalEmit.apply(socket, [eventName, ...args]);
  };

  socket.on("error", (err) => {
    console.error(`Socket Hatası (ID: ${socket.id}):`, err);
  });

  socket.on("user-join", (username) => {
    if (connectedUsers >= 2) {
      socket.emit("server-full");
      socket.disconnect(true);
      console.log(`Bağlantı reddedildi. Sunucu dolu. Kullanıcı: ${username}`);
      return;
    }

    connectedUsers++;
    users[socket.id] = {
      username,
      id: socket.id,
      hasAudio: true,
      hasVideo: true,
    };
    console.log("Kullanıcı bağlandı:", username, socket.id);

    socket.join(SERVER_ROOM); // Kullanıcıyı otomatik olarak server odasına ekle

    // Mevcut kullanıcıların bilgisini gönder
    io.to(SERVER_ROOM).emit("existing-users", Object.values(users));

    // Yeni kullanıcının katıldığını diğerlerine bildir
    socket.broadcast
      .to(SERVER_ROOM)
      .emit("user-joined", { username, id: socket.id });

    // Mevcut video durumunu gönder
    socket.emit("video-state", videoState);

    // Mevcut video listesini gönder
    fs.readdir(uploadDir, (err, files) => {
      if (err) {
        console.error("Video dizini okunurken hata:", err);
        return;
      }
      socket.emit("available-videos", files);
    });

    // Mevcut yükleme durumunu gönder
    socket.emit("upload-status", isUploading);

    // Diğer kullanıcıların medya durumlarını yeni bağlanan kullanıcıya gönder
    Object.keys(users).forEach((userId) => {
      if (userId !== socket.id) {
        socket.emit("remote-media-toggled", {
          socketId: users[userId].id,
          audio: users[userId].hasAudio,
          video: users[userId].hasVideo,
        });
      }
    });
    // **Yeni: STUN sunucu bilgilerini gönder**
    socket.emit("ice-servers", iceServers);
  });

  socket.on("toggle-media", ({ audio, video }) => {
    users[socket.id].hasAudio = audio;
    users[socket.id].hasVideo = video;

    // Tüm kullanıcılara yeni durumu ilet
    io.to(SERVER_ROOM).emit("remote-media-updated", {
      userId: socket.id,
      audio,
      video,
    });
  });

  // Video kontrol olayları (aynı kalır)
  socket.on("play", () => {
    videoState.isPlaying = true;
    io.to(SERVER_ROOM).emit("play");
  });

  socket.on("pause", () => {
    videoState.isPlaying = false;
    io.to(SERVER_ROOM).emit("pause");
  });

  socket.on("seek", (time) => {
    videoState.currentTime = time;
    io.to(SERVER_ROOM).emit("seek", time);
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

  socket.on("disconnect", () => {
    if (users[socket.id]) {
      console.log("Kullanıcı ayrıldı:", users[socket.id].username, socket.id);
      delete users[socket.id];
      connectedUsers = Object.keys(users).length;
      io.to(SERVER_ROOM).emit("existing-users", Object.values(users));
      io.to(SERVER_ROOM).emit("user-left", socket.id);
      socket.leave(SERVER_ROOM); // Kullanıcı ayrıldığında odadan çık
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
