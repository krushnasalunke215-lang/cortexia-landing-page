document.addEventListener('DOMContentLoaded', () => {
    /* --- Mobile Menu Toggle --- */
    const mobileBtn = document.querySelector('.mobile-menu-btn');
    if (mobileBtn) {
        mobileBtn.addEventListener('click', () => {
            document.querySelector('.nav-links').classList.toggle('active');
        });
    }

    /* --- Scroll Reveal Animations --- */
    const animatedElements = document.querySelectorAll('.feature-card, .timeline-item, .content-block, .form-container');
    const scrollObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });

    animatedElements.forEach(el => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(30px)';
        el.style.transition = 'all 0.8s cubic-bezier(0.16, 1, 0.3, 1)';
        scrollObserver.observe(el);
    });

    /* --- Interactive Mockup Chart Animation --- */
    const bars = document.querySelectorAll('.bar');
    bars.forEach((bar, index) => {
        const originalHeight = bar.style.height;
        bar.style.height = '0%';
        setTimeout(() => {
            bar.style.height = originalHeight;
        }, 600 + (index * 150));
    });

    /* --- Animated Numbers on Dashboard --- */
    const counters = document.querySelectorAll('.stat-value');
    counters.forEach(counter => {
        const updateCount = () => {
            const target = +counter.getAttribute('data-target');
            if(!target) return; // skip text elements
            
            const count = +counter.innerText.replace('%','');
            const inc = target / 50; // speed

            if (count < target) {
                let current = count + inc;
                if(target % 1 !== 0) {
                     counter.innerText = current.toFixed(1) + (counter.innerText.includes('%') ? '%' : '');
                } else {
                     counter.innerText = Math.ceil(current) + (counter.innerText.includes('%') ? '%' : '');
                }
                setTimeout(updateCount, 30);
            } else {
                if(target % 1 !== 0) {
                     counter.innerText = target.toFixed(1) + (counter.innerText.includes('%') ? '%' : '');
                } else {
                     counter.innerText = target + (counter.innerText.includes('%') ? '%' : '');
                }
            }
        };
        setTimeout(updateCount, 1200); // Start after fade-in
    });

    /* --- FAQ Accordion Logic --- */
    const faqItems = document.querySelectorAll('.faq-item');
    faqItems.forEach(item => {
        const question = item.querySelector('.faq-question');
        question.addEventListener('click', () => {
            // Close others
            faqItems.forEach(otherItem => {
                if(otherItem !== item) otherItem.classList.remove('active');
            });
            // Toggle current
            item.classList.toggle('active');
        });
    });

    /* --- Dynamic Text Formatting (Hero) --- */
    const dynamicText = document.querySelector('.dynamic-text');
    if(dynamicText) {
        const words = ['Lead', 'Customer', 'Sale', 'Opportunity'];
        let wordIndex = 0;
        setInterval(() => {
            dynamicText.style.opacity = 0;
            setTimeout(() => {
                wordIndex = (wordIndex + 1) % words.length;
                dynamicText.textContent = words[wordIndex];
                dynamicText.style.opacity = 1;
            }, 400); // Wait for fade out
        }, 3000);
        dynamicText.style.transition = "opacity 0.4s ease";
    }

    /* --- Tab Switching in Mockup --- */
    const tabs = document.querySelectorAll('.m-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            // Flash effect to simulate loading
            const content = document.querySelector('.mockup-tab-content');
            content.style.opacity = '0.5';
            setTimeout(() => content.style.opacity = '1', 300);
        });
    });

});

/* Live Contact Form via Web3Forms AJAX */
function submitForm(e) {
    e.preventDefault();
    const form = document.getElementById('contact-form');
    const formData = new FormData(form);
    
    const btn = document.getElementById('submit-btn');
    const msg = document.getElementById('success-msg');
    
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
    btn.style.opacity = 0.8;
    btn.disabled = true;

    fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            btn.style.display = 'none';
            msg.style.display = 'block';
            form.reset();
        } else {
            console.error(data);
            btn.innerHTML = originalText;
            btn.style.opacity = 1;
            btn.disabled = false;
        }
    })
    .catch(error => {
        console.error(error);
        btn.innerHTML = originalText;
        btn.style.opacity = 1;
        btn.disabled = false;
    });
}
