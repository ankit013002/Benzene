package com.nebulavault.user_service.user;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface UserRepository extends JpaRepository<User, UUID> {

    Optional<User> findByAuthSub(String authSub);

    Optional<User> findByEmail(String email);

    long deleteByAuthSub(String authSub);
}
