// server.js
const express = require("express");
const https = require("https");
const cors = require("cors");
const { Server } = require("socket.io");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { Busboy } = require('busboy'); // Busboy doğru şekilde import edildi

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

const uploadDir = path.join(__dirname, "videos");

// Upload dizinini oluştur
(async () => {
  try {
    await fs.promises.mkdir(uploadDir, { recursive: true });
  } catch (err) {
    console.error("Dizin oluşturulurken hata:", err);
  }
})();

app.use("/videos", express.static(uploadDir));

// Multer Ayarları
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
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
  limits: { fileSize: 16 * 1024 * 1024 * 1024 }, // 16GB
});

// Toplam dosya boyutunu kontrol eden middleware
const checkTotalFileSize = async (req, res, next) => {
  const maxSize = 16 * 1024 * 1024 * 1024; // 16GB
  let currentTotalSize = 0;

  try {
    const dir = await fs.promises.opendir(uploadDir);
    for await (const dirent of dir) {
      if (dirent.isFile()) {
        const stats = await fs.promises.stat(path.join(uploadDir, dirent.name));
        currentTotalSize += stats.size;
      }
    }

    const contentLength = parseInt(req.headers["content-length"] || "0", 10);

    if (currentTotalSize + contentLength > maxSize) {
      return res.status(413).send({ message: "Toplam dosya boyutu sınırı aşıldı (maksimum 16GB)." });
    }

    req.setTimeout(6 * 60 * 60 * 1000); // 6 saat
    next();
  } catch (error) {
    console.error("Toplam dosya boyutu kontrolü sırasında hata:", error);
    res.status(500).send({ message: "Sunucu hatası: Toplam boyut kontrolü yapılamadı." });
  }
};

let isUploading = false;

app.post("/upload", checkTotalFileSize, (req, res) => {
  if (isUploading) {
    return res.status(400).send({ message: "Şu anda başka bir yükleme işlemi devam ediyor." });
  }
  isUploading = true;
  io.emit("upload-start");

  const busboy = new Busboy({ headers: req.headers });
  const totalBytes = parseInt(req.headers["content-length"], 10);
  let uploadedBytes = 0;

  req.on("close", () => {
    if (uploadedBytes < totalBytes) {
      console.warn("Bağlantı kesildi. Yükleme tamamlanamadı.");
      isUploading = false;
      io.emit("upload-end");
    }
  });

  busboy.on("file", (fieldname, file, filename) => {
    const saveTo = path.join(uploadDir, `${Date.now()}-${filename}`);
    const writeStream = fs.createWriteStream(saveTo);

    file.pipe(writeStream);
    file.on("data", (chunk) => {
      uploadedBytes += chunk.length;
      const progress = Math.round((uploadedBytes / totalBytes) * 100);
      const remaining = Math.round(100 - progress);
      io.emit("upload-progress", { progress, remaining, speed: calculateSpeed(uploadedBytes) });
    });

    file.on("end", () => {
      console.log("Dosya alındı:", filename);
    });

    writeStream.on("finish", () => {
      isUploading = false;
      io.emit("upload-end");
      res.status(200).send({ message: "Dosya başarıyla yüklendi!", filename });
    });

    writeStream.on("error", (err) => {
      console.error("Dosya yazma hatası:", err.message);
      isUploading = false;
      io.emit("upload-end");
      res.status(500).send({ message: "Dosya kaydedilemedi." });
    });
  });

  busboy.on("error", (err) => {
    console.error("Busboy hatası:", err.message);
    isUploading = false;
    io.emit("upload-end");
    res.status(500).send({ message: "Yükleme sırasında bir hata oluştu." });
  });
  req.pipe(busboy);

  const calculateSpeed = (() => {
    let lastTime = Date.now();
    let lastUploadedBytes = 0;

    return (uploadedBytes) => {
      const currentTime = Date.now();
      const elapsed = (currentTime - lastTime) / 1000;
      const bytesDiff = Math.max(uploadedBytes - lastUploadedBytes, 0);

      if (elapsed > 0) {
        const speed = bytesDiff / elapsed;
        lastTime = currentTime;
        lastUploadedBytes = uploadedBytes;
        return Math.round(speed / 1024); // KB/s
      }
      return 0;
    };
  })();
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
    users[socket.id] = { username, id: socket.id };
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

  // WebRTC Sinyalizasyon olayları
  socket.on("offer", async (data) => {
    try {
      const { target, offer } = data;
      if (!users[target]) {
        console.error(`Offer hedefi bulunamadı. Hedef: ${target}, Gönderen: ${socket.id}`);
        return;
      }
      await io.to(target).emit("offer", { from: socket.id, offer });

    } catch (error) {
      console.error("Offer olayı sırasında bir hata oluştu:", error);
      socket.emit("error", `Offer sırasında bir hata oluştu : ${error.message}`);
    }
  });

  socket.on("answer", async (data) => {
    try {
      const { target, answer } = data;
      if (!users[target]) {
        console.error(`Answer hedefi bulunamadı. Hedef: ${target}, Gönderen: ${socket.id}`);
        return;
      }
      await io.to(target).emit("answer", { from: socket.id, answer });
    } catch (error) {
      console.error("Answer olayı sırasında bir hata oluştu:", error);
      socket.emit("error", `Answer sırasında bir hata oluştu : ${error.message}`);
    }
  });

  socket.on("ice-candidate", async (data) => {
    try {
      const { target, candidate } = data;
      if (!users[target]) {
        console.error(`ICE candidate hedefi bulunamadı. Hedef: ${target}, Gönderen: ${socket.id}`);
        return;
      }
      await io.to(target).emit("ice-candidate", { from: socket.id, candidate });
    } catch (error) {
      console.error("ICE Candidate olayı sırasında hata oluştu:", error);
      socket.emit("error", `ICE Candidate sırasında bir hata oluştu : ${error.message}`);
    }
  });

  // Video Call İstekleri
  socket.on("request-video-call", () => {
    const otherUserSocketId = Object.keys(users).find(
      (id) => id !== socket.id
    );
    if (otherUserSocketId) {
      io.to(otherUserSocketId).emit("incoming-video-call", socket.id);
    }
  });

  // Kullanıcı çıkışı, ayrıldı.
  socket.on("disconnect", () => {
    if (users[socket.id]) {
      console.log("Kullanıcı ayrıldı:", users[socket.id].username, socket.id);
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