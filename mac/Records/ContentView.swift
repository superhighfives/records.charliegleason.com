import MusicKit
import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var playerState = ApplicationMusicPlayer.shared.state
    @ObservedObject private var queue = ApplicationMusicPlayer.shared.queue

    private var trackTitle: String {
        queue.currentEntry?.title
            ?? (model.nowShowing.title.isEmpty ? "Waiting for the board…" : model.nowShowing.title)
    }

    private var trackArtist: String {
        queue.currentEntry?.subtitle ?? model.nowShowing.artist
    }

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(.gray.opacity(0.15))
                if let url = model.nowShowing.coverURL {
                    AsyncImage(url: url) { image in
                        image.resizable().aspectRatio(contentMode: .fill)
                    } placeholder: {
                        ProgressView()
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .frame(width: 280, height: 280)
            .shadow(radius: 20, y: 8)

            VStack(spacing: 2) {
                Text(trackTitle)
                    .font(.headline)
                    .lineLimit(1)
                if !trackArtist.isEmpty {
                    Text(trackArtist)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            HStack(spacing: 28) {
                Button {
                    Task { await model.player.skipToPrevious() }
                } label: {
                    Image(systemName: "backward.fill")
                }
                Button {
                    Task { await model.player.togglePlayPause() }
                } label: {
                    Image(systemName: playerState.playbackStatus == .playing ? "pause.fill" : "play.fill")
                }
                .font(.title2)
                Button {
                    Task { await model.player.skipToNext() }
                } label: {
                    Image(systemName: "forward.fill")
                }
            }
            .buttonStyle(.plain)
            .disabled(playerState.playbackStatus == .stopped)

            if model.player.authorizationStatus != .authorized {
                Button("Connect Apple Music") {
                    Task { await model.player.requestAuthorization() }
                }
                .font(.caption)
            }

            if let error = model.player.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(24)
        .frame(width: 320)
    }
}
