'use strict';
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.pricing-option').forEach(function(opt) {
    opt.addEventListener('click', function() {
      const radioName = this.querySelector('input[type=radio]') && this.querySelector('input[type=radio]').name;
      if (radioName) {
        document.querySelectorAll('.pricing-option').forEach(function(p) { p.classList.remove('selected'); });
      }
      this.classList.add('selected');
      const radio = this.querySelector('input[type=radio]');
      if (radio) { radio.checked = true; }
      if (typeof updateOrderSummary === 'function') updateOrderSummary();
    });
  });
  document.querySelectorAll('.payment-option').forEach(function(opt) {
    opt.addEventListener('click', function() {
      document.querySelectorAll('.payment-option').forEach(function(p) { p.classList.remove('selected'); });
      this.classList.add('selected');
      const radio = this.querySelector('input[type=radio]');
      if (radio) radio.checked = true;
    });
  });
});
