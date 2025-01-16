// Backend Kaynak Kodları:
// server.js
const express = require("express");
const https = require("https");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();

// HTTPS Sertifikaları
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

// Sağlık kontrol endpoint'i
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

// Upload dizinini oluştur (eğer yoksa)
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer ayarları
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
  limits: { fileSize: 16 * 1024 * 1024 * 1024 }, // Her bir dosya için sınır (16GB)
});

// Toplam dosya boyutunu kontrol eden middleware
const checkTotalFileSize = async (req, res, next) => {
  const maxSize = 16 * 1024 * 1024 * 1024; // Toplam boyut sınırı (16GB)
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

    // Dosya yükleme işlemi için özel timeout
    req.setTimeout(6 * 60 * 60 * 1000); // 6 saat
    next();
  } catch (error) {
    console.error("Toplam dosya boyutu kontrolü sırasında hata:", error);
    return res
      .status(500)
      .send({ message: "Sunucu hatası: Toplam boyut kontrolü yapılamadı." });
  }
};

let isUploading = false; // Yükleme durumunu takip etmek için
let lastTime = Date.now(); // Dosya yükleme hızını hesaplama
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
  return 0
};
app.post("/upload", checkTotalFileSize, (req, res) => {
  if (isUploading) {
    return res.status(400).send({ message: "Şu anda başka bir yükleme işlemi devam ediyor." });
  }
  isUploading = true;
  io.emit("upload-start"); // Yükleme başladığını diğer kullanıcılara bildir
  let uploadedBytes = 0;
  try {
    upload.single("video")(req, res, (err) => {
      isUploading = false;
      io.emit("upload-end");
      if (err) {
        console.error("Yükleme hatası:", err.message);
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).send({ message: "Dosya boyutu sınırı aşıldı (maksimum 16GB)." });
        }
        return res.status(400).send({ message: `Yükleme hatası: ${err.message}` });
      }
      if (!req.file) {
        return res.status(400).send({ message: "Lütfen geçerli bir video dosyası yükleyin." });
      }
      console.log("Dosya başarıyla yüklendi:", req.file.filename);
      res.status(200).send({
        message: "Dosya başarıyla yüklendi!",
        filename: req.file.filename,
      });
    });

    req.on('data', (chunk) => {
      uploadedBytes += chunk.length;
      const totalBytes = parseInt(req.headers['content-length'], 10);
      const progress = totalBytes > 0 ? (uploadedBytes / totalBytes) * 100 : 0;
      io.emit("upload-progress", { progress: Math.round(progress), speed: calculateSpeed(chunk.length) });
    });
  } catch (error) {
    isUploading = false;
    io.emit("upload-end");
    console.error("Video yükleme sırasında bir hata oluştu:", error);
    res.status(500).send({ message: "Sunucu hatası: Video yüklenemedi." });
  }
});

// Video silme endpoint'i
app.delete("/videos/:filename", async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);

  try {
    await fs.promises.unlink(filePath);
    console.log(`Dosya başarıyla silindi: ${filename}`);
    // Silme olayını tüm bağlı istemcilere yayınla
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

// Kullanıcı ve video durumu
let connectedUsers = 0;
const users = {};
const mediaStreams = {}; // Kullanıcıların medya akışlarını saklamak için
const videoRooms = {}; // { roomId: [socketId1, socketId2, ...] }
let videoState = {
  isPlaying: false,
  currentTime: 0,
  muted: false,
  volume: 1, // 0-1 arası
  currentVideo: null,
};

// Socket.io bağlantıları
io.on("connection", (socket) => {
  console.log("Yeni bir soket bağlandı:", socket.id);

  // Gelen olayları logla (debug amaçlı)
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

  // Giden olayları logla (debug amaçlı)
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

  // Socket error handling
  socket.on("error", (err) => {
    console.error(`Socket Hatası (ID: ${socket.id}):`, err);
  });

  // Kullanıcı giriş yapınca
  socket.on("user-join", (username) => {
    // Maksimum 2 kullanıcı
    if (connectedUsers >= 2) {
      socket.emit("server-full");
      socket.disconnect(true);
      console.log(`Bağlantı reddedildi. Sunucu dolu. Kullanıcı: ${username}`);
      return;
    }

    connectedUsers++;
    users[socket.id] = { username, id: socket.id, hasAudio: false, hasVideo: false };
    console.log("Kullanıcı bağlandı:", username, socket.id);

    // Mevcut kullanıcıları tüm kullanıcılara gönder
    const sendUpdatedUsers = () => {
      io.emit("existing-users", Object.values(users));
    };
    sendUpdatedUsers();

    // Diğer kullanıcılara yeni kullanıcının katıldığını bildir
    socket.broadcast.emit("user-joined", { username, id: socket.id });

    // Kullanıcıya mevcut video durumunu gönder
    socket.emit("video-state", videoState);

    // Mevcut video dosya listesini gönder
    const videoDir = path.join(__dirname, "videos");
    fs.readdir(videoDir, (err, files) => {
      if (err) {
        console.error("Video dizini okunurken hata:", err);
        return;
      }
      socket.emit("available-videos", files);
    });

    // Mevcut video dosya listesini gönder
    const sendAvailableVideos = () => {
      fs.readdir(uploadDir, (err, files) => {
        if (err) {
          console.error("Video dizini okunurken hata:", err);
          return;
        }
        io.emit("available-videos", files);
      });
    };

    sendAvailableVideos()

    // Mevcut yükleme durumunu gönder
    socket.emit("upload-status", isUploading);
  });

  // Kullanıcı medya durumunu güncellediğinde (SFU mantığına göre)
  socket.on("toggle-media", ({ audio, video }) => {
    if (users[socket.id]) {
      users[socket.id].hasAudio = audio;
      users[socket.id].hasVideo = video;
      // Aynı odadaki diğer kullanıcılara bildir
      Object.keys(videoRooms).forEach(roomId => {
        if (videoRooms[roomId].includes(socket.id)) {
          videoRooms[roomId].forEach(userSocketId => {
            if (userSocketId !== socket.id) {
              io.to(userSocketId).emit("remote-media-toggled", {
                socketId: socket.id,
                audio,
                video,
              });
            }
          });
        }
      });
    }
  });

  // Kullanıcı video odasına katılma isteği
  socket.on("join-video-room", (targetUserId) => {
    const roomId = [socket.id, targetUserId].sort().join("_"); // Unique room ID
    socket.join(roomId);

    if (!videoRooms[roomId]) {
      videoRooms[roomId] = [];
    }

    if (!videoRooms[roomId].includes(socket.id)) {
      videoRooms[roomId].push(socket.id);
    }

    // Notify the user who initiated the call
    io.to(targetUserId).emit("user-joined-video-room", socket.id);

    // Notify the current user that they've joined
    socket.emit("user-joined-video-room", targetUserId);

    // Send initial media status to the new user
    const otherUserSocketId = videoRooms[roomId].find(id => id !== socket.id);
    if (otherUserSocketId && users[otherUserSocketId]) {
      socket.emit("remote-media-stream", {
        socketId: otherUserSocketId,
        audio: users[otherUserSocketId].hasAudio,
        video: users[otherUserSocketId].hasVideo,
      });
    }
  });

  // Kullanıcı video odasından ayrılma isteği
  socket.on("leave-video-room", (targetUserId) => {
    const roomId = [socket.id, targetUserId].sort().join("_");
    socket.leave(roomId);

    if (videoRooms[roomId]) {
      videoRooms[roomId] = videoRooms[roomId].filter(id => id !== socket.id);
      if (videoRooms[roomId].length === 0) {
        delete videoRooms[roomId];
      } else {
        // Notify the other user in the room
        videoRooms[roomId].forEach(userSocketId => {
          io.to(userSocketId).emit("user-left-video-room", socket.id);
        });
      }
    }
  });

  // Video kontrol olayları
  socket.on("play", () => {
    videoState.isPlaying = true;
    io.emit("play");
  });

  socket.on("pause", () => {
    videoState.isPlaying = false;
    io.emit("pause");
  });

  socket.on("seek", (time) => {
    videoState.currentTime = time;
    io.emit("seek", time);
  });

  socket.on("mute", () => {
    videoState.muted = true;
    io.emit("mute");
  });

  socket.on("unmute", () => {
    videoState.muted = false;
    io.emit("unmute");
  });

  socket.on("volume-change", (volume) => {
    videoState.volume = volume;
    io.emit("volume-change", volume);
  });

  socket.on("select-video", (filename) => {
    videoState.currentVideo = filename;
    videoState.isPlaying = false;
    videoState.currentTime = 0;
    io.emit("video-selected", filename);
    io.emit("video-state", videoState);
  });

  // Kullanıcı çıkışı, ayrıldı.
  socket.on("disconnect", () => {
    if (users[socket.id]) {
      console.log("Kullanıcı ayrıldı:", users[socket.id].username, socket.id);
      // Video odalarından ayrıldığını bildir
      Object.keys(videoRooms).forEach(roomId => {
        if (videoRooms[roomId].includes(socket.id)) {
          videoRooms[roomId] = videoRooms[roomId].filter(id => id !== socket.id);
          videoRooms[roomId].forEach(userSocketId => {
            io.to(userSocketId).emit("user-left-video-room", socket.id);
          });
          if (videoRooms[roomId].length === 0) {
            delete videoRooms[roomId];
          }
        }
      });
      delete users[socket.id];
      connectedUsers = Object.keys(users).length;
      const sendUpdatedUsers = () => {
        io.emit("existing-users", Object.values(users));
      };
      sendUpdatedUsers();
      io.emit("user-left", socket.id);
    }
  });
});

// Express genel hata yakalama middleware
app.use((err, req, res, next) => {
  console.error("Express Error Handler:", err);
  res.status(500).json({
    error: "Sunucuda bir hata oluştu. Detaylar konsolda yer alıyor.",
  });
});

const PORT = 8443;
server.listen(PORT, () => {
  console.log(`Sunucu HTTPS üzerinden ${PORT} portunda çalışıyor.`);
});