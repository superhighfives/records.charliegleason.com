// A minimal embedded HTTP server the `rec` board talks to over the LAN:
// `POST /now` mirrors whatever album the board is currently showing onto
// this app's display, and `POST /play` is the board's touch press asking
// this app to actually start Apple Music playback (see MusicPlayer.swift
// for why that has to happen here and not on the board itself).
//
// Built on Network.framework rather than a third-party HTTP library — the
// surface area is three routes with small JSON bodies and no keep-alive,
// well within what a hand-rolled parser can handle reliably.
import Foundation
import Network

@MainActor
protocol RecordsServerDelegate: AnyObject {
    func serverDidReceiveNowShowing(artist: String, title: String, coverURL: String?)
    func serverDidReceivePlay(artist: String, title: String) async
}

// All mutable state here is only ever touched on the `.main` queue (the
// listener and every connection are started with `queue: .main`), so the
// class is safe to share across the @Sendable Network.framework callbacks
// even though the compiler can't verify that itself.
final class RecordsServer: @unchecked Sendable {
    private static let serviceType = "_recplay._tcp"

    private var listener: NWListener?
    weak var delegate: RecordsServerDelegate?
    private let port: NWEndpoint.Port

    init(port: UInt16 = 51735) {
        self.port = NWEndpoint.Port(rawValue: port) ?? 51735
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        let listener = try NWListener(using: parameters, on: port)
        listener.service = NWListener.Service(name: "Records", type: Self.serviceType)
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.stateUpdateHandler = { state in
            if case .failed(let error) = state {
                print("Records server failed: \(error)")
            }
        }
        listener.start(queue: .main)
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: .main)
        receive(on: connection, buffer: Data())
    }

    private func receive(on connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data, !data.isEmpty {
                buffer.append(data)
            }
            if let request = self.parseRequest(buffer) {
                self.respond(to: request, on: connection)
                return
            }
            if isComplete || error != nil {
                connection.cancel()
                return
            }
            self.receive(on: connection, buffer: buffer)
        }
    }

    private struct ParsedRequest {
        let method: String
        let path: String
        let body: Data
    }

    private func parseRequest(_ buffer: Data) -> ParsedRequest? {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let headerString = String(data: buffer[..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        let lines = headerString.components(separatedBy: "\r\n")
        guard let requestLine = lines.first else { return nil }
        let parts = requestLine.split(separator: " ")
        guard parts.count >= 2 else { return nil }

        var contentLength = 0
        for line in lines.dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1)
            if pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                contentLength = Int(pair[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }

        let bodyStart = headerEnd.upperBound
        guard buffer.count - bodyStart >= contentLength else { return nil }
        let body = buffer[bodyStart..<(bodyStart + contentLength)]
        return ParsedRequest(method: String(parts[0]), path: String(parts[1]), body: Data(body))
    }

    private func respond(to request: ParsedRequest, on connection: NWConnection) {
        switch (request.method, request.path) {
        case ("GET", "/health"):
            send(json: ["status": "ok"], status: "200 OK", on: connection)

        case ("POST", "/now"):
            guard let payload = jsonObject(request.body),
                  let artist = payload["artist"] as? String,
                  let title = payload["title"] as? String
            else {
                send(json: ["error": "expected {\"artist\", \"title\"}"], status: "400 Bad Request", on: connection)
                return
            }
            let coverURL = payload["coverUrl"] as? String
            Task { @MainActor [weak delegate] in
                delegate?.serverDidReceiveNowShowing(artist: artist, title: title, coverURL: coverURL)
            }
            send(json: ["status": "ok"], status: "200 OK", on: connection)

        case ("POST", "/play"):
            guard let payload = jsonObject(request.body),
                  let artist = payload["artist"] as? String,
                  let title = payload["title"] as? String
            else {
                send(json: ["error": "expected {\"artist\", \"title\"}"], status: "400 Bad Request", on: connection)
                return
            }
            Task { @MainActor [weak delegate] in
                await delegate?.serverDidReceivePlay(artist: artist, title: title)
            }
            send(json: ["status": "playing"], status: "200 OK", on: connection)

        default:
            send(json: ["error": "not found"], status: "404 Not Found", on: connection)
        }
    }

    private func jsonObject(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    private func send(json: [String: Any], status: String, on connection: NWConnection) {
        let body = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        var response = "HTTP/1.1 \(status)\r\n"
        response += "Content-Type: application/json\r\n"
        response += "Content-Length: \(body.count)\r\n"
        response += "Connection: close\r\n\r\n"
        var data = Data(response.utf8)
        data.append(body)
        connection.send(content: data, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
