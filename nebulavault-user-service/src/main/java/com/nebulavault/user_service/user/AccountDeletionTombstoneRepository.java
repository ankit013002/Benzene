package com.nebulavault.user_service.user;

import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.repository.query.Param;

public interface AccountDeletionTombstoneRepository
        extends JpaRepository<AccountDeletionTombstone, String> {

    @Modifying
    @Query(value = """
            INSERT INTO account_deletion_tombstones (auth_sub)
            VALUES (:authSub)
            ON CONFLICT (auth_sub) DO NOTHING
            """, nativeQuery = true)
    int recordDeletion(@Param("authSub") String authSub);
}
