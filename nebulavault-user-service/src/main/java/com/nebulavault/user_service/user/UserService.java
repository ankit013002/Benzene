package com.nebulavault.user_service.user;

import jakarta.persistence.EntityManager;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class UserService {
    private final UserRepository userRepo;
    private final AccountDeletionTombstoneRepository tombstoneRepo;
    private final EntityManager entityManager;

    public UserService(
            UserRepository userRepo,
            AccountDeletionTombstoneRepository tombstoneRepo,
            EntityManager entityManager
    ){
        this.userRepo = userRepo;
        this.tombstoneRepo = tombstoneRepo;
        this.entityManager = entityManager;
    }

    @Transactional
    public User bootstrap(String authSub, String email, String name){
        lockSubject(authSub);
        if (tombstoneRepo.existsById(authSub)) {
            throw new ResponseStatusException(
                    HttpStatus.GONE,
                    "Account deletion has been requested"
            );
        }

        return userRepo.findByAuthSub(authSub).map(user -> {
            boolean dirty = false;
            if(email != null && !email.equals(user.getEmail())){
                user.setEmail(email);
                dirty = true;
            }
            if(name != null && !name.equals(user.getName())){
                user.setName(name);
                dirty = true;
            }
            return dirty ? userRepo.save(user) : user;
        }).orElseGet(() -> userRepo.save(new User(authSub, email, name)));
    }

    public User meByAuthSub(String authSub){
        return userRepo.findByAuthSub(authSub).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not Found"));
    }

    @Transactional
    public long deleteByAuthSub(String authSub) {
        lockSubject(authSub);
        tombstoneRepo.recordDeletion(authSub);
        return userRepo.deleteByAuthSub(authSub);
    }

    private void lockSubject(String authSub) {
        entityManager.createNativeQuery(
                        "SELECT pg_advisory_xact_lock(hashtextextended(:authSub, 0))"
                )
                .setParameter("authSub", authSub)
                .getSingleResult();
    }
}
