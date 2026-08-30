import Foundation

struct NowShowing: Equatable {
    var artist: String = ""
    var title: String = ""
    var coverURL: URL?
}

@MainActor
final class AppModel: ObservableObject, RecordsServerDelegate {
    @Published var nowShowing = NowShowing()
    let player = MusicPlayer()
    private let server = RecordsServer()

    func start() {
        server.delegate = self
        do {
            try server.start()
        } catch {
            player.lastError = "Couldn't start the board listener: \(error.localizedDescription)"
        }
    }

    func serverDidReceiveNowShowing(artist: String, title: String, coverURL: String?) {
        nowShowing = NowShowing(artist: artist, title: title, coverURL: coverURL.flatMap(URL.init(string:)))
    }

    func serverDidReceivePlay(artist: String, title: String) async {
        await player.play(artist: artist, title: title)
    }
}
