package com.nebulavault.user_service.user;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

@Component
public class InternalServiceSecret {
    private final byte[] expected;

    public InternalServiceSecret(
            @Value("${BENZENE_INTERNAL_SERVICE_SECRET:}") String configuredSecret
    ) {
        this.expected = configuredSecret.getBytes(StandardCharsets.UTF_8);
        if (this.expected.length < 32) {
            throw new IllegalStateException(
                    "BENZENE_INTERNAL_SERVICE_SECRET must contain at least 32 UTF-8 bytes"
            );
        }
    }

    public boolean matches(String candidate) {
        if (candidate == null) return false;
        return MessageDigest.isEqual(
                expected,
                candidate.getBytes(StandardCharsets.UTF_8)
        );
    }
}
