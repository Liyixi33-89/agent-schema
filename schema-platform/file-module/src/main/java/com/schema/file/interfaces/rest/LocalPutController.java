package com.schema.file.interfaces.rest;

import com.schema.file.domain.FilePolicy;
import com.schema.file.infrastructure.storage.LocalFsStorage;
import com.schema.file.infrastructure.storage.LocalFsStorage.Op;
import com.schema.file.infrastructure.storage.LocalFsStorage.TokenBinding;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * LocalFs credential-consuming endpoints (S3 direct-upload semantics, 11BE §2):
 * - PUT /api/files/local-put/{token}: one-time credential write (consumed on read, no replay);
 *   validates op type / expiry / size cap - mirrors S3 presigned constraints;
 * - GET /api/files/local-get/{token}: download (forced attachment + nosniff - stored-XSS headers);
 * - Ops are strictly isolated: PUT endpoint accepts op=PUT/PART only, GET endpoint op=GET only.
 */
@RestController
public class LocalPutController {

    private final LocalFsStorage storage;

    public LocalPutController(LocalFsStorage storage) {
        this.storage = storage;
    }

    /** Presigned PUT consumption (multipart part write when ?part=N present). */
    @PutMapping(value = "/api/files/local-put/{token}", consumes = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<Void> put(@PathVariable String token,
            @RequestParam(value = "part", required = false) Integer part,
            @RequestBody byte[] body) {
        TokenBinding binding = LocalFsStorage.consumeBinding(token);
        if (binding == null || binding.expired()) {
            return ResponseEntity.status(401).build();   // expired or replayed
        }
        if (part != null) {
            // multipart part: credential must be PART op; part number 1..MAX_PARTS
            if (binding.op() != Op.PART || part < 1 || part > FilePolicy.MAX_PARTS) {
                return ResponseEntity.status(401).build();
            }
            if (body.length > binding.maxBytes()) {
                return ResponseEntity.status(413).build();
            }
            storage.writePart(binding.objectKey(), part, body);
            return ResponseEntity.ok().eTag(LocalFsStorage.sha256(body)).build();
        }
        if (binding.op() != Op.PUT) {
            return ResponseEntity.status(401).build();   // GET/SESSION credential not usable for PUT
        }
        if (binding.maxBytes() > 0 && body.length > binding.maxBytes()) {
            return ResponseEntity.status(413).build();   // over presigned size cap
        }
        storage.write(binding.objectKey(), body);
        return ResponseEntity.ok().eTag(LocalFsStorage.sha256(body)).build();
    }

    /** Presigned GET consumption (forced download - svg/html content-domain redline, 11BE §6). */
    @GetMapping("/api/files/local-get/{token}")
    public ResponseEntity<byte[]> get(@PathVariable String token) {
        TokenBinding binding = LocalFsStorage.consumeBinding(token);
        if (binding == null || binding.expired() || binding.op() != Op.GET) {
            return ResponseEntity.status(401).build();   // expired/replayed/op mismatch
        }
        byte[] bytes = storage.read(binding.objectKey());
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"file\"")
                .header("X-Content-Type-Options", "nosniff")
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .body(bytes);
    }
}
