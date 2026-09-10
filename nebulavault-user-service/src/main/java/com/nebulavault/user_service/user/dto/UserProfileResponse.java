package com.nebulavault.user_service.user.dto;

import com.nebulavault.user_service.user.User;

import java.time.OffsetDateTime;
import java.util.UUID;

/** The stable profile contract consumed by the web application. */
public record UserProfileResponse(
        UUID id,
        String email,
        String name,
        String avatarUrl,
        String plan,
        long quotaBytes,
        long usedBytes,
        OffsetDateTime createdAt,
        OffsetDateTime updatedAt
) {
    public static UserProfileResponse from(User user) {
        return new UserProfileResponse(
                user.getId(),
                user.getEmail(),
                user.getName(),
                user.getAvatarUrl(),
                user.getPlan(),
                user.getQuotaBytes(),
                user.getUsedBytes(),
                user.getCreatedAt(),
                user.getUpdatedAt());
    }
}
