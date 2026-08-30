// Plays an Apple Music catalog album via MusicKit.
//
// AppleScript against Music.app cannot reliably control catalog (streaming)
// playback — only local library items. That's a documented platform
// limitation, not something to work around further; MusicKit is the real,
// supported way to authorize and stream arbitrary catalog content.
import Foundation
import MusicKit
import os

@MainActor
final class MusicPlayer: ObservableObject {
    private let logger = Logger(subsystem: "com.superhighfives.Records", category: "MusicPlayer")
    @Published var authorizationStatus: MusicAuthorization.Status = MusicAuthorization.currentStatus
    @Published var lastError: String?

    func requestAuthorization() async {
        authorizationStatus = await MusicAuthorization.request()
        logger.notice("authorization status: \(self.authorizationStatus)")
    }

    func play(artist: String, title: String) async {
        logger.notice("play requested: \(artist) – \(title), current auth: \(self.authorizationStatus)")
        if authorizationStatus != .authorized {
            await requestAuthorization()
            guard authorizationStatus == .authorized else {
                lastError = "Apple Music access isn't authorized."
                logger.notice("not authorized after request: \(self.authorizationStatus)")
                return
            }
        }

        do {
            let subscription = try await MusicSubscription.current
            logger.notice("subscription: canPlayCatalogContent=\(subscription.canPlayCatalogContent) canBecomeSubscriber=\(subscription.canBecomeSubscriber)")
            guard subscription.canPlayCatalogContent else {
                lastError = "This Apple ID can't stream Apple Music catalog content (no active subscription)."
                logger.notice("catalog playback not permitted for this account")
                return
            }

            var request = MusicCatalogSearchRequest(term: "\(artist) \(title)", types: [Album.self])
            request.limit = 1
            let response = try await request.response()
            guard let album = response.albums.first else {
                lastError = "No Apple Music match for \(artist) – \(title)."
                logger.notice("no search results")
                return
            }
            logger.notice("found album: \(album.title) — \(album.artistName), playable: \(album.playParameters != nil)")

            let player = ApplicationMusicPlayer.shared
            player.queue = ApplicationMusicPlayer.Queue(for: [album])
            logger.notice("queue set via container initializer, preparing")
            try await player.prepareToPlay()
            logger.notice("prepared, calling play()")
            try await player.play()
            logger.notice("play() returned, playbackStatus: \(String(describing: player.state.playbackStatus))")
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            logger.notice("error: \(error)")
        }
    }

    // Transport controls for the Mac-side control plane — the board only
    // ever asks for a fresh album via play(); everything else (pause,
    // resume, skip within the playing album's tracks) happens here.
    func togglePlayPause() async {
        let player = ApplicationMusicPlayer.shared
        if player.state.playbackStatus == .playing {
            player.pause()
            return
        }
        do {
            try await player.play()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            logger.notice("resume error: \(error)")
        }
    }

    func skipToNext() async {
        do {
            try await ApplicationMusicPlayer.shared.skipToNextEntry()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            logger.notice("skip next error: \(error)")
        }
    }

    func skipToPrevious() async {
        do {
            try await ApplicationMusicPlayer.shared.skipToPreviousEntry()
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            logger.notice("skip previous error: \(error)")
        }
    }
}
