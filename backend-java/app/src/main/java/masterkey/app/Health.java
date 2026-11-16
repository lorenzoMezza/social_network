// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code GET /health}, without sign-in (API.md, Conventions). */
@RestController
@RequestMapping("/v1")
class Health {

    @GetMapping("/health")
    Map<String, Object> health() {
        return Map.of("ok", true);
    }
}
