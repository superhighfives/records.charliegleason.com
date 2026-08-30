import SwiftUI

@main
struct RecordsApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
                .task {
                    model.start()
                    await model.player.requestAuthorization()
                }
        }
        .windowResizability(.contentSize)
    }
}
