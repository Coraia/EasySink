import Darwin
import Foundation

enum NativeInstanceLockError: Error, Equatable {
    case alreadyRunning
    case unavailable(Int32)
}

final class NativeInstanceLock {
    private var descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    static func acquire(directory: URL) throws -> NativeInstanceLock {
        let path = directory.appendingPathComponent("desktop-native.lock", isDirectory: false).path
        let descriptor = Darwin.open(path, O_CREAT | O_RDWR | O_NOFOLLOW, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw NativeInstanceLockError.unavailable(errno) }
        var information = stat()
        guard fstat(descriptor, &information) == 0 else {
            let code = errno
            Darwin.close(descriptor)
            throw NativeInstanceLockError.unavailable(code)
        }
        guard information.st_uid == getuid(), information.st_mode & 0o077 == 0 else {
            Darwin.close(descriptor)
            throw NativeInstanceLockError.unavailable(EACCES)
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let code = errno
            Darwin.close(descriptor)
            if code == EWOULDBLOCK { throw NativeInstanceLockError.alreadyRunning }
            throw NativeInstanceLockError.unavailable(code)
        }
        return NativeInstanceLock(descriptor: descriptor)
    }

    deinit {
        if descriptor >= 0 {
            flock(descriptor, LOCK_UN)
            Darwin.close(descriptor)
            descriptor = -1
        }
    }
}
