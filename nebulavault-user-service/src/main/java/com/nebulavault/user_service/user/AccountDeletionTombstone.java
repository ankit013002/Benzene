package com.nebulavault.user_service.user;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

import java.time.OffsetDateTime;

@Entity
@Table(name = "account_deletion_tombstones")
public class AccountDeletionTombstone {
    @Id
    @Column(name = "auth_sub", nullable = false, updatable = false)
    private String authSub;

    @Column(name = "created_at", nullable = false, insertable = false, updatable = false)
    private OffsetDateTime createdAt;

    protected AccountDeletionTombstone() {
    }

    public AccountDeletionTombstone(String authSub) {
        this.authSub = authSub;
    }

    public String getAuthSub() {
        return authSub;
    }

    public OffsetDateTime getCreatedAt() {
        return createdAt;
    }
}
