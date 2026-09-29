package com.nebulavault.user_service.user;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock
    private UserRepository userRepository;

    @Mock
    private AccountDeletionTombstoneRepository tombstoneRepository;

    @Mock
    private AuthSubjectTransactionLock subjectLock;

    @InjectMocks
    private UserService userService;

    @Test
    void bootstrapsAndReturnsANewProfileForAnUnknownSubject() {
        UUID id = UUID.randomUUID();
        when(userRepository.findByAuthSub("auth-sub")).thenReturn(Optional.empty());
        when(userRepository.save(any(User.class))).thenAnswer(invocation -> {
            User saved = invocation.getArgument(0);
            saved.setId(id);
            return saved;
        });

        User result = userService.bootstrap("auth-sub", "ada@example.com", "Ada");

        assertThat(result.getId()).isEqualTo(id);
        assertThat(result.getAuthSub()).isEqualTo("auth-sub");
        assertThat(result.getEmail()).isEqualTo("ada@example.com");
        assertThat(result.getName()).isEqualTo("Ada");
        verify(userRepository).save(any(User.class));
        verify(subjectLock).lock("auth-sub");
    }

    @Test
    void repeatBootstrapIsIdempotentWhenProfileClaimsHaveNotChanged() {
        User existing = new User("auth-sub", "ada@example.com", "Ada");
        existing.setId(UUID.randomUUID());
        when(userRepository.findByAuthSub("auth-sub")).thenReturn(Optional.of(existing));

        User result = userService.bootstrap("auth-sub", "ada@example.com", "Ada");

        assertThat(result).isSameAs(existing);
        verify(userRepository, never()).save(any(User.class));
        verify(subjectLock).lock("auth-sub");
    }

    @Test
    void meFailsClearlyWhenTheSubjectHasNotBeenBootstrapped() {
        when(userRepository.findByAuthSub("missing")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> userService.meByAuthSub("missing"))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("User not Found");
    }

    @Test
    void accountProfileDeletionIsIdempotentForAnAlreadyAbsentSubject() {
        when(userRepository.deleteByAuthSub("auth-sub")).thenReturn(1, 0);

        assertThat(userService.deleteByAuthSub("auth-sub")).isEqualTo(1L);
        assertThat(userService.deleteByAuthSub("auth-sub")).isZero();

        verify(userRepository, times(2)).deleteByAuthSub("auth-sub");
        verify(subjectLock, times(2)).lock("auth-sub");
    }

    @Test
    void existingDeletionTombstonePreventsAStaleSessionFromRecreatingProfile() {
        when(tombstoneRepository.existsById("deleted-sub")).thenReturn(true);

        assertThatThrownBy(() -> userService.bootstrap(
                "deleted-sub",
                "ada@example.com",
                "Ada"
        ))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("Account deletion has been requested");

        verify(userRepository, never()).findByAuthSub("deleted-sub");
        verify(subjectLock).lock("deleted-sub");
    }
}
