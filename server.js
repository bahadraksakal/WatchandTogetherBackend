// server.js
const express = require("express");
const https = require("https"); // http yerine https kullandık
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

const server = https.createServer(credentials, app); // https.createServer kullanıldı
const io = new Server(server, {
  cors: {
    origin: "*", // Üretim ortamında burayı kısıtlamanız önerilir
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
    const files = await fs.promises.readdir(uploadDir); // fs.promises.readdir kullanıldı
    for (const file of files) {
      const stats = await fs.promises.stat(path.join(uploadDir, file)); // fs.promises.stat kullanıldı
      currentTotalSize += stats.size;
    }

    // req.headers['content-length'] undefined olabilir, bu yüzden varsayılan olarak 0 ekleyelim
    const contentLength = parseInt(req.headers["content-length"] || "0", 10);

    if (currentTotalSize + contentLength > maxSize) {
      return res.status(413).send({
        message:
          "Toplam dosya boyutu sınırı aşıldı (maksimum 16GB). Yeni dosya yüklenemez.",
      });
    }
    next();
  } catch (error) {
    console.error("Toplam dosya boyutu kontrolü sırasında hata:", error);
    return res
      .status(500)
      .send({ message: "Sunucu hatası: Toplam boyut kontrolü yapılamadı." });
  }
};

// Video yükleme endpoint'i (toplam boyut kontrolü eklenmiş)
app.post("/upload", checkTotalFileSize, (req, res) => {
  try {
    upload.single("video")(req, res, (err) => {
      if (err) {
        // Multer hatalarını yakalama (dosya boyutu aşımı dahil)
        console.error("Yükleme hatası:", err.message);
        if (err.code === "LIMIT_FILE_SIZE") {
          return res
            .status(413)
            .send({ message: "Dosya boyutu sınırı aşıldı (maksimum 16GB)." });
        }
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
  } catch (error) {
    console.error("Video yükleme sırasında bir hata oluştu:", error);
    res.status(500).send({ message: "Sunucu hatası: Video yüklenemedi." });
  }
});

// Video silme endpoint'i
app.delete("/videos/:filename", async (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(uploadDir, filename);

  try {
    await fs.promises.unlink(filePath); // fs.promises.unlink kullanıldı
    console.log(`Dosya başarıyla silindi: ${filename}`);
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

    // Yeni kullanıcıya mevcut kullanıcıları gönder
    const existingUsers = Object.values(users).filter(
      (user) => user.id !== socket.id
    );
    socket.emit("existing-users", existingUsers);

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
  socket.on("offer", (data) => {
    try {
      const { target, offer } = data;
      if (!users[target]) {
        console.error("Offer hedefi bulunamadı.", data);
        return;
      }
      io.to(target).emit("offer", { from: socket.id, offer });
    } catch (error) {
      console.error("Offer olayı sırasında bir hata oluştu:", error);
    }
  });

  socket.on("answer", (data) => {
    try {
      const { target, answer } = data;
      if (!users[target]) {
        console.error("Answer hedefi bulunamadı.", data);
        return;
      }
      io.to(target).emit("answer", { from: socket.id, answer });
    } catch (error) {
      console.error("Answer olayı sırasında bir hata oluştu:", error);
    }
  });

  socket.on("ice-candidate", (data) => {
    try {
      const { target, candidate } = data;
      if (!users[target]) {
        console.error("ICE candidate hedefi bulunamadı.", data);
        return;
      }
      io.to(target).emit("ice-candidate", { from: socket.id, candidate });
    } catch (error) {
      console.error("ICE Candidate olayı sırasında hata oluştu:", error);
    }
  });

  // Basit sesli arama olayları (İPTAL - WebRTC kullanıyoruz)
  // socket.on('start-audio-call', () => {
  //   console.log(`Kullanıcı ${users[socket.id]?.username} sesli arama başlattı.`);
  //   socket.broadcast.emit('audio-call-started', socket.id);
  // });

  // socket.on('end-audio-call', () => {
  //   console.log(`Kullanıcı ${users[socket.id]?.username} sesli aramayı bitirdi.`);
  //   socket.broadcast.emit('audio-call-ended', socket.id);
  // });

  // Kullanıcı çıkışı
  socket.on("disconnect", () => {
    if (users[socket.id]) {
      console.log("Kullanıcı ayrıldı:", users[socket.id].username, socket.id);
      delete users[socket.id];
      connectedUsers--;
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
