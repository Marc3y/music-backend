# music-backend

Dieses Projekt ist die eine Hälfte des music-Projekts (die andere ist [music-frontend](https://github.com/Marc3y/music-frontend)). Die Inspiration liegt hierbei bei dem Projekt untitled. Auf der Seite kann man Songs, Beats und Projekte hochladen und in verschiedenen Playlists kategorisieren, sowie bestimmte Songs, Projekte oder auch Playlists mit anderen Personen teilen. Ebenfalls ist es möglich, Personen als Collaborator bestimmter Playlists hinzuzufügen.

Dieses Repository ist die Express/MongoDB-API, die sowohl [music-frontend](https://github.com/Marc3y/music-frontend) als auch die native iOS/macOS-App ([music-app](https://github.com/Marc3y/music-app)) bedient.

## Tech-Stack

- **Node.js / Express** mit TypeScript
- **MongoDB** als Datenbank
- S3-kompatibler Objektspeicher (self-hosted MinIO) für Audiodateien, Projektarchive und Cover, Zugriff über den AWS SDK v3
- `jsonwebtoken` + `bcrypt` für Authentifizierung (Access-/Refresh-Token als httpOnly-Cookies)
- `zod` zur Validierung aller eingehenden Requests
- `music-metadata` zum Auslesen eingebetteter ID3-Tags beim Upload
- `resend` für transaktionale E-Mails (Verifizierung, Passwort-Reset)
- `express-rate-limit` für Rate-Limiting auf sensiblen Routen (Login, Registrierung, Passwort-Flows)
- Supabase ausschließlich als Google-OAuth-Broker

## Features / API-Bereiche

### Auth & Konto (`/auth`, `/account`)

- Registrierung mit E-Mail-Code-Verifizierung, Login, Logout
- Google-Login über Supabase als OAuth-Broker
- Passwort vergessen/zurücksetzen per E-Mail
- Access-/Refresh-Token-Flow über httpOnly-Cookies, automatisches Erneuern
- Profil: Benutzername ändern, Profilbild hochladen/löschen (presigned Upload)
- Passwort ändern (zweistufig: Code anfordern, dann bestätigen)
- Konto löschen (zweistufig: Code anfordern, dann bestätigen)
- Speicherverbrauch, Nutzungsübersicht und Statistiken (Top-Tracks, Top-Hörer) pro Konto

### Playlists (`/playlists`)

- Anlegen, Umbenennen, Löschen, Cover-Upload
- Eigene Sortierreihenfolge (Drag & Drop, serverseitig persistiert)
- Collaborator hinzufügen/entfernen, Beitritt über Einladungslink (`/playlists/join/:token`)
- Öffentliches Teilen: aktivieren/deaktivieren, Passwortschutz, Download erlauben/verbieten, Einschränkung auf bestimmte Benutzernamen
- Öffentliche, nicht authentifizierte Endpunkte zum Abspielen/Herunterladen geteilter Playlists samt Hörzähler

### Audiodateien (`/audio-files`)

- Direkter Upload über presigned S3-URLs (Init → Upload → Confirm), getrennt für Audiodateien und Projektarchive (`.zip`/`.rar`)
- Mehrere Versionen pro Track, Auswahl der aktiven Hauptversion, versionierte BPM-/Tonart-Metadaten
- Pro Version optional eine eigene Projektdatei (eigener Upload-/Download-/Lösch-Flow)
- Automatisches Auslesen eingebetteter ID3-Metadaten (Titel, Künstler) beim Upload
- Streaming-Endpunkt mit Hörzähler (zählt einmal pro Wiedergabe nach einer Mindestdauer)
- Öffentliches Teilen einzelner Tracks/Projektdateien mit Passwortschutz
- Sortierreihenfolge innerhalb einer Playlist persistierbar

### Benachrichtigungen (`/notifications`)

- Echtzeit-Stream per Server-Sent Events (`/notifications/stream`)
- Liste aller Benachrichtigungen, Als-gelesen-Markieren
- Automatisches Löschen alter Benachrichtigungen nach 60 Tagen (MongoDB TTL-Index)

### Sonstiges

- Idempotente Datenmigrationen beim Serverstart (z. B. Überführen alter Tracks ins Versionsmodell, Normalisieren der Tonart-Schreibweise)
- `trust proxy` für korrekte Client-IPs hinter nginx (wichtig für Rate-Limiting)
- Abo-Stufen (Free / Plus / Unlimited) mit unterschiedlichen Speicherlimits, manuell in der Datenbank gepflegt
