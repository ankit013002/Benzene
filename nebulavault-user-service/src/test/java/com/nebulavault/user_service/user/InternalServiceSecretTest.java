package com.nebulavault.user_service.user;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertThrows;

class InternalServiceSecretTest {
    @Test
    void refusesASecretShorterThanThirtyTwoUtf8Bytes() {
        assertThrows(
                IllegalStateException.class,
                () -> new InternalServiceSecret("short")
        );
    }
}
