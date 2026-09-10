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
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock
    private UserRepository userRepository;

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
    }

    @Test
    void repeatBootstrapIsIdempotentWhenProfileClaimsHaveNotChanged() {
        User existing = new User("auth-sub", "ada@example.com", "Ada");
        existing.setId(UUID.randomUUID());
        when(userRepository.findByAuthSub("auth-sub")).thenReturn(Optional.of(existing));

        User result = userService.bootstrap("auth-sub", "ada@example.com", "Ada");

        assertThat(result).isSameAs(existing);
        verify(userRepository, never()).save(any(User.class));
    }

    @Test
    void meFailsClearlyWhenTheSubjectHasNotBeenBootstrapped() {
        when(userRepository.findByAuthSub("missing")).thenReturn(Optional.empty());

        assertThatThrownBy(() -> userService.meByAuthSub("missing"))
                .isInstanceOf(org.springframework.web.server.ResponseStatusException.class)
                .hasMessageContaining("User not Found");
    }
}
