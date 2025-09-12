try { meta = JSON.parse(fs.readFileSync(metaPath)); } catch (e) {}
      }
      const inMem = Object.values(sessions).find(s => s.folderName === n);
      return { folder: n, meta, online: !!inMem, lastSeen: meta.connectedAt || null };
    });
    socket.emit('sessions_list', arr);
  });

  socket.on('destroy_session', (payload) => {
    try {
      if (!payload || !payload.folder) return socket.emit('error', { message: 'folder required' });
      const folder = payload.folder;
      const target = Object.entries(sessions).find(([k, v]) => v.folderName === folder);
      if (target) {
        const [sid, val] = target;
        try { val.sock.end(); } catch(e){}
        delete sessions[sid];
      }
      const full = path.join(SESSIONS_BASE, folder);
      if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      socket.emit('session_destroyed', { folder });
    } catch (err) {
      console.error('destroy_session error', err);
      socket.emit('error', { message: "Échec de la suppression de session", detail: String(err) });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log('Client web déconnecté', socket.id, 'raison:', reason);
  });
});

// logs
process.on('uncaughtException', (err) => console.error('uncaughtException', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection', reason));

// start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(Serveur démarré sur http://localhost:${PORT} (port ${PORT})));
