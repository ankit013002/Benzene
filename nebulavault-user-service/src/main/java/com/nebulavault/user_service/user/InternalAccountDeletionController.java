package com.nebulavault.user_service.user;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

@RestController
@RequestMapping("/internal/account-deletion")
public class InternalAccountDeletionController {
    private static final String SECRET_HEADER = "X-Benzene-Internal-Secret";

    private final UserService userService;
    private final InternalServiceSecret internalServiceSecret;

    public InternalAccountDeletionController(
            UserService userService,
            InternalServiceSecret internalServiceSecret
    ) {
        this.userService = userService;
        this.internalServiceSecret = internalServiceSecret;
    }

    @DeleteMapping("/{authSub}")
    public ResponseEntity<Void> deleteProfile(
            @PathVariable UUID authSub,
            @RequestHeader(value = SECRET_HEADER, required = false) String presentedSecret
    ) {
        if (!internalServiceSecret.matches(presentedSecret)) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).build();
        }

        userService.deleteByAuthSub(authSub.toString());
        return ResponseEntity.noContent().build();
    }
}
